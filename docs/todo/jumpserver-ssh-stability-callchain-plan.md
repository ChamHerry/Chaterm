# JumpServer / SSH 稳定性深度调用链路分析与最佳实施方案

> 生成日期：2026-05-15  
> 范围：`chaterm_2026-05-15.log` 中 JumpServer/SSH/resize/MFA 相关 error/warn，结合官方文档、GitHub 开源实现、本项目源码调用链。  
> 目标：给出最小可验证、可分阶段落地的最佳实施方案；本文档不直接修改业务代码。

## 1. 结论摘要

### 1.1 是否是本项目问题

| 问题 | 是否属于项目问题 | 置信度 | 结论 |
|---|---:|---:|---|
| JumpServer exec 命令 30s 超时 | 是 | 高 | 多个后台探测命令复用同一个交互式 exec shell，缺少串行队列/互斥，导致输出串台与 marker 解析失败。 |
| `Resize failed` | 是 | 高 | 前端 resize 在 `connectionId` 为空或 shell 未 ready 时触发，主进程找不到对应 stream。 |
| `Failed to set, key not found` | 是 | 高 | `inputManager.setActiveTerm(connectionId.value)` 被调用时 key 尚未注册，且多次为空字符串。 |
| `read ETIMEDOUT` 后未进入网络断开重连 | 是，处理不完整 | 中高 | 普通 SSH 有 closeInfo 分类；JumpServer shell close 发送空 payload，renderer 无法判定网络断开。 |
| `All configured authentication methods failed` | 不一定 | 中 | 认证失败可能来自 OTP/key/password/服务端策略；但项目 MFA UI 与认证方式选择会放大问题。 |

### 1.2 最佳实施顺序

1. **先修 JumpServer exec 串行化**：新增 per-session command queue / mutex，保证 command list、system info、PID probe 不再并发写同一 stream。
2. **再修 resize readiness gate**：连接 ID 非空、shell ready、尺寸变化有效时才下发；shell 未 ready 时只缓存 latest resize。
3. **补齐 JumpServer closeInfo**：JumpServer 复用普通 SSH 的网络错误分类，向 renderer 传递 `{ reason, isNetworkDisconnect, errorCode, errorMessage }`。
4. **修 MFA 交互状态**：提交 OTP 后不立即 reset，对失败结果保持当前 dialog，成功或 final failure 后关闭。
5. **分层补测试与日志字段**：先单元测试锁定队列/resize/close/MFA，再做手动 JumpServer 验证。

---

## 2. 外部资料与实现调研

### 2.1 官方文档要点

#### ssh2 官方 README / API

- `conn.exec(command)` 是执行单条远程命令的标准方式，stream 的 `close` 会携带 exit code/signal；官方示例使用独立 exec stream 收集 stdout/stderr。来源：ssh2 README `Execute 'uptime'` 示例，`conn.exec` 与 stream close/data/stderr 处理见 GitHub README 行 307-325。  
  Source: https://github.com/mscdex/ssh2
- `conn.shell()` 是交互式 shell，会把命令回显、prompt、输出混在同一个双工 stream 中；官方 shell 示例显示 shell 输出会包含命令文本与 prompt。来源：ssh2 README shell 示例行 338-381。  
  Source: https://github.com/mscdex/ssh2
- `tryKeyboard: true` 表示主认证方法失败后尝试 keyboard-interactive，并且必须处理 `keyboard-interactive` event。来源：ssh2 README API 行 1028-1029、1109。  
  Source: https://github.com/mscdex/ssh2
- `setWindow(rows, cols, height, width)` 用于告知服务端本地终端大小变化；rows/cols 非 0 时优先于 pixel width/height。来源：ssh2 README Channel/Pseudo-TTY API 行 1373-1404。  
  Source: https://github.com/mscdex/ssh2
- `readyTimeout` 是 SSH handshake 等待时间，默认 20000ms；`keepaliveInterval` 控制 SSH-level keepalive。来源：ssh2 README API 行 1087-1105。  
  Source: https://github.com/mscdex/ssh2

**对本项目的含义：** JumpServer 目标资产命令执行因无法直接 `conn.exec()`，当前用交互式 shell + marker 模拟 exec；该模式天然必须串行化，否则多条命令输出无法可靠归属。

#### xterm.js 官方文档

- `Terminal.onResize` 会在 terminal resize 时触发，并返回新 size。来源：xterm.js Terminal API 行 224-231。  
  Source: https://xtermjs.org/docs/api/terminal/classes/terminal/
- xterm.js 官方建议对 resize 调用 debounce，确保 backing pty 能响应 resize event。来源：Terminal `resize` API 行 726-733。  
  Source: https://xtermjs.org/docs/api/terminal/classes/terminal/
- FitAddon 用于让 terminal geometry 适配容器；官方用法是在 DOM container 存在并 `term.open()` 后调用 `fitAddon.fit()`。来源：Using addons 行 17-28。  
  Source: https://xtermjs.org/docs/guides/using-addons/

**对本项目的含义：** 前端 resize 不应只 debounce，还要有 session-ready gate；否则 DOM 生命周期产生的 early resize 会打到尚未创建的后端 stream。

#### JumpServer 官方资料

- JumpServer 支持通过 SSH 协议使用 Xshell 等终端连接，默认 SSH 服务端口示例为 2222。来源：JumpServer 官方文章行 28-45。  
  Source: https://www.jumpserver.com/blog/connecting-via-ssh-terminal
- 直连 JumpServer 资产可使用 `JumpServerUsername@systemUsername@AssetIP@JumpServerHostIP` 格式；当多个资产同 IP 时会展示选择表并输入资产 ID。来源：官方文章行 56-96。  
  Source: https://www.jumpserver.com/blog/connecting-via-ssh-terminal
- JumpServer 客户端连接 Linux/设备资产支持 SSH/SFTP，并可执行命令、上传下载文件。来源：JumpServer 文档 Asset Connection 行 207-238。  
  Source: https://docs.jumpserver.org/zh/v4/en/manual/client/asset_connection/
- JumpServer 支持多种 MFA；OTP 是一次性动态密码，用户名密码完成后仍需二次验证。来源：JumpServer Profile 文档行 215-230。  
  Source: https://docs.jumpserver.org/zh/v4/en/manual/user/profile/

**对本项目的含义：** 资产选择、账号选择、MFA 和 SSH 登录是不同阶段；客户端日志不能把所有 `client-authentication` 都等价成“OTP 错误”。

### 2.2 GitHub 开源实现调研

| 项目 | 相关实现 | 可借鉴点 |
|---|---|---|
| Infisical `pam-ssh-session-handler.ts` | 打开 `ssh2.Client.shell({ term, rows, cols })`，shell ready 后转发输入/输出；resize message 直接对 ready shell stream 调 `setWindow`。 | resize 只在已有 shellStream 的消息处理分支中执行；shell 未建立则不会调用。Source: https://github.com/Infisical/infisical/blob/main/backend/src/ee/services/pam-web-access/pam-ssh-session-handler.ts |
| Extraterm `SSHPty.ts` | resize 时如果 state 不是 `LIVE`，缓存 `#preliveCols/#preliveRows`；shell ready 后一次性应用缓存尺寸。 | 这是本项目 resize early event 的最佳参考：缓存 latest resize，ready 后 flush。Source: https://github.com/sedwards2009/extraterm/blob/master/extensions/SSHSessionBackend/src/SSHPty.ts |
| Microsoft Azure Pipelines `ssh2helpers.ts` | 远程命令优先使用 `sshClient.exec(command)`；需要交互时用 `exec(command, { pty: true })` 并以单条 stream close 判定完成。 | 标准 SSH 命令执行应尽量用独立 exec stream；只有 JumpServer 不支持时才用 shell marker 模拟。Source: https://github.com/microsoft/azure-pipelines-tasks/blob/master/Tasks/SshV0/ssh2helpers.ts |
| certd `ssh.ts` | `tryKeyboard: true`，并注释提醒 server 可能多次触发 keyboard-interactive，且用途不只认证。 | MFA UI 不能假设一次提交后立即 reset；应等待明确 success/failure/final。Source: https://github.com/certd/certd/blob/v2/packages/ui/certd-server/src/plugins/plugin-lib/ssh/ssh.ts |
| Termix / OpenSSH-like terminal implementations | 连接配置常见 `tryKeyboard: true` + keepalive + readyTimeout；resize 前检查 connected/stream 状态。 | 对本项目可补 `connected/shellReady` 状态与 latest resize 缓存，减少噪音错误。Source: GitHub grep results for `tryKeyboard: true` and `setWindow(rows, cols, 0, 0)` |

---

## 3. 本项目当前调用链深度分析

### 3.1 JumpServer 连接链路

```text
src/renderer/src/views/components/Ssh/sshConnect.vue
  connectSSH()
  ├─ 构造 connData: id / host / username / password / privateKey / sshType / targetIp / preferredLoginUsername
  └─ api.connect(connData)

src/preload/index.ts
  api.connect -> ipcRenderer.invoke('ssh:connect', connectionInfo)

src/main/ssh/sshHandle.ts
  registerSSHHandlers()
  └─ ipcMain.handle('ssh:connect')
     ├─ logger 'ssh.connect.request'
     ├─ if sshType === 'jumpserver'
     │   └─ handleJumpServerConnection(connectionInfo, event)
     └─ catch -> logger 'ssh.connect.jumpserver.error' -> buildErrorResponse(error)

src/main/ssh/jumpserver/connectionManager.ts
  handleJumpServerConnection()
  └─ for attempt in 1..3
     └─ attemptJumpServerConnection(connectionInfo, event, attempt)
        ├─ build connectConfig
        │  ├─ tryKeyboard: true
        │  ├─ readyTimeout: 180000
        │  ├─ keepaliveInterval: 10000
        │  └─ privateKey 优先，否则 password
        ├─ conn.on('keyboard-interactive') -> handleJumpServerKeyboardInteractive()
        ├─ conn.on('ready') -> conn.shell() -> setupJumpServerInteraction()
        └─ conn.on('error') -> logger 'jumpserver.error'
```

关键源码证据：

- `src/renderer/src/views/components/Ssh/sshConnect.vue:1616-1645`：构造 `connData`。
- `src/preload/index.ts:1137`：`connect` IPC bridge。
- `src/main/ssh/sshHandle.ts:1464-1492`：`ssh:connect` JumpServer 分支与错误日志。
- `src/main/ssh/jumpserver/connectionManager.ts:158-180`：connectConfig 基础参数。
- `src/main/ssh/jumpserver/connectionManager.ts:186-197`：`privateKey` 优先，否则 password。
- `src/main/ssh/jumpserver/connectionManager.ts:203-225`：keyboard-interactive 事件处理。
- `src/main/ssh/jumpserver/connectionManager.ts:250-285`：`conn.on('error')` 记录 `jumpserver.error` 并把 `client-authentication` 归类为 MFA failed。
- `src/main/ssh/jumpserver/connectionManager.ts:292-329`：3 次重试与最终 throw。

#### 发现的问题

1. **认证失败归因过粗**  
   `All configured authentication methods failed` 被项目日志映射为 `JumpServer MFA authentication failed`，但 ssh2 官方认证顺序可能包含 password/privateKey/agent/keyboard-interactive。仅凭该错误不能判定一定是 OTP 错误。

2. **privateKey 与 password 同时存在时，项目只配置 privateKey**  
   当前代码 `if privateKey else if password`。日志中 `hasPassword` 与 `hasPrivateKey` 都为真，但 connectConfig 只放 privateKey。这符合“key auth 优先”的实现，但如果 JumpServer 场景需要 password 或 keyboard-interactive fallback，需要更明确的 `authHandler` 策略。

3. **MFA UI 状态过早 reset**  
   `src/renderer/src/components/global/mfa/mfaState.ts:178-188` 提交 OTP 后立即 `resetOtpDialog()`，后续失败结果到达时 `currentOtpId` 已是 null，日志中多次出现 `currentOtpId: null`。这会导致失败提示/重试交互失效。

---

### 3.2 JumpServer 资产导航链路

```text
connectionManager.ts conn.on('ready')
  -> conn.shell({ term })
  -> setupJumpServerInteraction(stream, connectionInfo, ...)

interaction.ts setupJumpServerInteraction()
  state: connecting -> inputIp -> selectUser -> inputPassword -> connected
  ├─ 看到 'Opt>'：输入 targetIp
  ├─ 看到用户选择表：parseJumpServerUsers -> 自动选择或弹窗选择
  ├─ 看到 Password：发送资产密码
  ├─ 检测连接成功：detectDirectConnectionReason()
  └─ handleConnectionSuccess()
      ├─ jumpserverConnections.set(connectionId, { conn, stream, jumpserverUuid, targetIp, navigationPath })
      ├─ jumpserverShellStreams.set(connectionId, stream)
      ├─ jumpserverConnectionStatus.set(connectionId, { isVerified: true })
      ├─ createJumpServerExecStream(connectionId) // 后台 command list/sudo probe
      └─ resolve({ status: 'connected' })
```

关键源码证据：

- `src/main/ssh/jumpserver/interaction.ts:42-50`：连接状态机和 navigationPath。
- `src/main/ssh/jumpserver/interaction.ts:150-156`：检测 `Opt>` 并输入目标 IP。
- `src/main/ssh/jumpserver/interaction.ts:179-288`：用户选择流程。
- `src/main/ssh/jumpserver/interaction.ts:291-315`：密码输入流程。
- `src/main/ssh/jumpserver/interaction.ts:342-345`：密码后成功检测。
- `src/main/ssh/jumpserver/interaction.ts:55-73`：成功后写入全局 maps，并启动 exec stream。

#### 发现的问题

1. `handleConnectionSuccess()` 一旦 resolve，renderer 即认为 connected；但后台 `createJumpServerExecStream()` 与 command list 仍在异步执行。
2. 连接成功后立即开始多个后台探测：command list、sudo、system info、PID；这些探测没有统一调度器。
3. `navigationPath` 缓存了目标资产选择路径，这是创建 secondary exec shell 的关键；该设计正确，但执行命令层必须串行。

---

### 3.3 JumpServer exec 模拟链路与根因

```text
interaction.ts handleConnectionSuccess()
  -> createJumpServerExecStream(connectionId)
  -> executeCommandOnJumpServerExec(execStream, command-list)
  -> executeCommandOnJumpServerExec(execStream, sudo-check)

sshConnect.vue startShell()
  -> loadOsInfoOnce()
     -> window.api.getSystemInfo(connectionId)
        -> preload ssh:get-system-info
        -> sshHandle.ts getSystemInfo(id)
        -> createJumpServerExecStream(id)
        -> executeCommandOnJumpServerExec(execStream, systemInfoScript)

sshConnect.vue connect success
  -> api.setShellPid(connectionId)
     -> preload ssh:shell-pid-set
     -> sshHandle.ts ipcMain.handle('ssh:shell-pid-set')
     -> createJumpServerExecStream(id)
     -> executeCommandOnJumpServerExec(execStream, pidScript)
```

关键源码证据：

- `src/main/ssh/jumpserver/streamManager.ts:179-243`：`createJumpServerExecStream()`，按 connectionId 缓存一个 exec stream。
- `src/main/ssh/jumpserver/streamManager.ts:245-337`：`executeCommandOnJumpServerExec()`，生成 marker，写入 command + marker + exit marker，监听同一 stream 的 data。
- `src/main/ssh/jumpserver/streamManager.ts:315-325`：30 秒超时后返回 `Command execution timeout`。
- `src/main/ssh/jumpserver/interaction.ts:73-119`：连接成功后用 exec stream 获取 command list 与 sudo。
- `src/main/ssh/sshHandle.ts:2418-2470`：`ssh:shell-pid-set` 使用 exec stream 获取 shell PID。
- `src/main/ssh/sshHandle.ts:2583-2639`：`getSystemInfo()` 在 JumpServer 连接上也使用 exec stream。
- `src/preload/index.ts:37` 与 `src/preload/index.ts:1147-1169`：command list 前端等待超时也是 30000ms。

#### 日志证据

`Get jumpserver pid result` 的 `stdout` 中混入了：

- command list 的 `compgen -A builtin; compgen -A command`
- system info 的 `uname -a / OS_VERSION / DEFAULT_SHELL / SUDO_CHECK`
- PID probe 的 `__PID__ / __PPID__`
- 多组 `__CHATERM_EXEC_END_*` / `__CHATERM_EXIT_CODE_*`

这说明多个 `executeCommandOnJumpServerExec()` 调用正在同时监听和写入同一交互式 shell stream。每个调用都只知道自己的 marker，但 stream 输出已经互相污染，导致 marker 找不到、exit marker 错配或解析延迟，最终触发 30s timeout。

#### 根因判断

**根因是项目代码缺少 JumpServer exec per-session 串行队列。**  
由于 JumpServer 资产命令执行不是标准 `conn.exec()`，而是 shell marker 模拟，因此必须保证同一 exec stream 上任何时刻只运行一条命令。

---

### 3.4 Resize 链路与根因

```text
xterm terminal.onResize(size)
  -> resizeSSH(size.cols, size.rows)

ResizeObserver / window.resize
  -> handleResize()
  -> fitAddon.fit()
  -> resizeSSH(cols, rows)

resizeSSH()
  -> api.resizeShell(connectionId.value, cols, rows)

preload
  -> ipcRenderer.invoke('ssh:shell:resize', { id, cols, rows })

sshHandle.ts
  -> ipcMain.handle('ssh:shell:resize')
  -> if jumpserverConnections.has(id)
     ├─ stream = jumpserverShellStreams.get(id)
     ├─ !stream -> error 'JumpServer Shell not found'
     └─ stream.setWindow(rows, cols, 0, 0)
```

关键源码证据：

- `src/renderer/src/views/components/Ssh/sshConnect.vue:390`：`connectionId = ref('')` 初始为空。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:598-600`：xterm onResize 直接调用 `resizeSSH()`。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:728-739`：ResizeObserver/window resize 触发 `handleResize()`。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:1280-1291`：fit 后调用 `resizeSSH()`。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:1894-1912`：`resizeSSH()` 调 IPC，失败记录 `Resize failed`。
- `src/main/ssh/sshHandle.ts:1829-1843`：主进程 resize handler。

#### 根因判断

1. 前端 early resize 在 `connectionId.value === ''` 或 shell 未 ready 时发出。
2. 主进程把“不存在/未 ready”作为 error 返回，renderer 记录 error 级别，造成噪音。
3. 项目已有 `RESIZE_GUARD_MS`，但它只保护 shellOpenedAt 后 500ms，不覆盖连接 ID 尚未生成/注册前的初始 DOM resize。

#### 最佳参考实现

Extraterm 在 `state !== LIVE` 时缓存 `preliveCols/preliveRows`，shell ready 后一次性 `setWindow()`；这是本项目最合适的 resize 策略。

---

### 3.5 active terminal key 链路与根因

```text
sshConnect.vue mounted/focus/watch
  -> inputManager.registerInstances(..., connectionId.value)
  -> inputManager.setActiveTerm(connectionId.value)
  -> inputManager.unregisterInstances(oldId)

termInputManager.ts
  componentInstances: ref<ComponentEntry[]>
  setActiveTerm(key)
    -> find key
    -> not found: logger.warn('Failed to set, key not found', { key })
```

关键源码证据：

- `src/renderer/src/views/components/Ssh/utils/termInputManager.ts:50-80`：注册、注销、set active 逻辑。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:756-761`：mounted 后延迟 100ms 注册实例，key 是 `connectionId.value`。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:916-917`：textarea focus 调 setActiveTerm。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:2737-2748`：connectionId 变更时 unregister oldId/register newId。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:4820`：focus 暴露方法中也 setActiveTerm。

#### 根因判断

多处 focus/resize/mount/watch 可能早于真实 `connectionId` 生成，导致 key 为空或尚未 register。该问题不直接导致 JumpServer 连接失败，但会影响全局输入/命令栏 active terminal 状态，并污染日志。

---

### 3.6 JumpServer closeInfo / 网络断开链路

普通 SSH：

```text
conn/stream error
  -> recordSessionConnectionError(id, err)
  -> setPendingShellCloseInfo(id, { reason: network|unknown, isNetworkDisconnect, errorCode, errorMessage })

stream close
  -> consumeShellCloseInfo(id)
  -> event.sender.send(`ssh:shell:close:${id}`, closeInfo)

renderer onShellClose(closeInfo)
  -> isNetworkDisconnect true => auto reconnect
```

JumpServer 当前：

```text
JumpServer stream close
  -> event.sender.send(`ssh:shell:close:${id}`) // 无 closeInfo

renderer onShellClose(undefined)
  -> navigator.onLine === true
  -> isNetworkDisconnect false
  -> 不重连
```

关键源码证据：

- `src/main/ssh/sshHandle.ts:589-624`：普通 SSH 网络错误码和 message pattern。
- `src/main/ssh/sshHandle.ts:641-667`：记录 session error。
- `src/main/ssh/sshHandle.ts:677-710`：消费 closeInfo。
- `src/main/ssh/sshHandle.ts:1769-1785`：普通 SSH shell close 发送 closeInfo。
- `src/main/ssh/sshHandle.ts:1654-1658`：JumpServer shell close 只发空 close event。
- `src/renderer/src/views/components/Ssh/sshConnect.vue:1812-1864`：renderer 只有 `closeInfo` 或浏览器离线时才进入网络重连。

#### 根因判断

`read ETIMEDOUT` 是网络/底层连接超时信号，但 JumpServer 分支没有把错误原因带给 renderer。导致日志里出现 `navigatorOnLine: true` 且 `isNetworkDisconnect: false`，自动重连不会启动。

---

## 4. 最佳实施方案

### 4.1 设计原则

1. **先稳定、后增强**：先消除超时/串台/误报，不做大范围重构。
2. **主路径保持兼容**：标准 SSH 保持 `conn.exec()`；JumpServer 保留 shell marker 模拟 exec，但加队列。
3. **每个状态边界显式化**：连接 ready、shell ready、exec ready、resize pending、MFA pending 都要有明确状态。
4. **错误分类可观测**：认证失败、网络断开、shell close、exec timeout 分别打结构化日志，避免混成 MFA failed。
5. **测试先锁行为**：对队列、resize gate、closeInfo、MFA state 先补单元测试再改实现。

### 4.2 Phase 0：回归测试与最小观测补强

#### 目标

在修复前先锁定现有失败模式，保证后续修改可证明改善。

#### 建议新增/修改测试

1. `src/main/ssh/jumpserver/__tests__/streamManager.queue.test.ts`
   - 模拟 execStream。
   - 并发调用 3 次 `executeCommandOnJumpServerExecQueued()`。
   - 验证写入顺序严格串行：第二条命令必须在第一条 resolve/timeout 后写入。
   - 验证 timeout 后队列继续处理下一条。

2. `src/main/ssh/__tests__/sshHandle.jumpserver-close.test.ts`
   - 构造 jumpserver stream error: `ETIMEDOUT`。
   - close 时应发送 `{ reason: 'network', isNetworkDisconnect: true, errorCode: 'ETIMEDOUT' }`。
   - 手动断开应发送 `{ reason: 'manual', isNetworkDisconnect: false }`。

3. `src/renderer/src/views/components/Ssh/utils/__tests__/termInputManager.test.ts`
   - `setActiveTerm('')` 不应 warn error；应 no-op 或 debug。
   - register 后 setActiveTerm 正常更新。

4. `src/renderer/src/components/global/mfa/__tests__/mfaState.test.ts`
   - submit 后不 reset 当前 id。
   - failed result 保持 dialog 并展示错误。
   - success/final failed 才 reset。

#### 验证命令

```bash
npm test -- src/main/ssh/jumpserver/__tests__/streamManager.queue.test.ts
npm test -- src/main/ssh/__tests__/sshHandle.jumpserver-close.test.ts
npm test -- src/renderer/src/views/components/Ssh/utils/__tests__/termInputManager.test.ts
npm test -- src/renderer/src/components/global/mfa/__tests__/mfaState.test.ts
```

---

### 4.3 Phase 1：JumpServer exec per-session 队列

#### 推荐方案

在 `src/main/ssh/jumpserver/streamManager.ts` 内新增 per-session queue，不新增第三方依赖。

#### 推荐 API

```ts
export async function executeCommandOnJumpServerExecQueued(
  connectionId: string,
  cmd: string,
  options?: {
    timeoutMs?: number
    kind?: 'command-list' | 'sudo-check' | 'system-info' | 'pid-probe' | 'cwd' | 'user-command'
  }
): Promise<JumpServerExecResult>
```

内部逻辑：

```text
Map<connectionId, Promise<void>> queueTail

enqueue(connectionId, task):
  previous = queueTail.get(connectionId) ?? Promise.resolve()
  current = previous.catch(noop).then(task).finally(cleanup)
  queueTail.set(connectionId, current.then(() => undefined, () => undefined))
  return current
```

#### 必须满足

1. 同一 `connectionId` 的 exec 命令严格串行。
2. timeout 后清理 listener，并继续队列下一项。
3. execStream close/error 时：
   - 清除 `jumpserverExecStreams`
   - reject 当前任务
   - 队列后续任务返回明确错误，不悬挂。
4. 日志字段增加：
   - `connectionId`
   - `kind`
   - `queueDepth`
   - `durationMs`
   - `timeoutMs`
   - `commandLength`
   - 不记录原始 command 内容，不记录 stdout 全量。

#### 涉及文件

- `src/main/ssh/jumpserver/streamManager.ts`
- `src/main/ssh/jumpserver/state.ts`
- `src/main/ssh/jumpserver/constants.ts`
- `src/main/ssh/jumpserver/executor.ts`
- `src/main/ssh/jumpserver/interaction.ts`
- `src/main/ssh/sshHandle.ts`

#### 替换点

| 当前调用 | 替换建议 |
|---|---|
| `interaction.ts` command list | `executeCommandOnJumpServerExecQueued(connectionId, cmd, { kind: 'command-list' })` |
| `interaction.ts` sudo check | `kind: 'sudo-check'` |
| `sshHandle.ts:getSystemInfo` | `kind: 'system-info'` |
| `sshHandle.ts:ssh:shell-pid-set` | `kind: 'pid-probe'` |
| `sshHandle.ts:ssh:cwd:get` | `kind: 'cwd'` |
| `ssh:conn:exec` JumpServer | `kind: 'user-command'` |

#### 验收标准

- 并发触发 command list + system info + pid probe，日志中不再出现 stdout 混入多个 marker。
- `jumpserver.exec.timeout` 降为 0 或只在真实远端命令卡住时出现。
- 即便某条探测超时，后续探测仍能运行。

---

### 4.4 Phase 2：前端 resize readiness gate + pending resize

#### 推荐方案

在 `sshConnect.vue` 增加 shellReady 状态与 latest pending resize。

#### 推荐状态

```ts
const shellReady = ref(false)
const pendingRemoteResize = ref<{ cols: number; rows: number } | null>(null)
const lastSentRemoteResize = ref<{ cols: number; rows: number } | null>(null)
```

#### 推荐逻辑

```text
requestRemoteResize(cols, rows):
  if cols/rows invalid => return
  if connectionId empty => pending = latest; return
  if !shellReady => pending = latest; return
  if same as lastSent => return
  debounce/send resizeShell

on startShell success:
  shellReady = true
  flush pending latest resize once

on close/disconnect/unmount:
  shellReady = false
  pending = null
  lastSent = null
```

#### 主进程配套

`ssh:shell:resize` 如果 shell not found，建议返回：

```ts
{ status: 'deferred', message: 'Shell not ready' }
```

renderer 对 `deferred` 不打 error，只 debug。

#### 涉及文件

- `src/renderer/src/views/components/Ssh/sshConnect.vue`
- `src/main/ssh/sshHandle.ts`
- 可能补类型：`src/preload/index.d.ts`

#### 验收标准

- 初始连接阶段不再产生 `Resize failed` error。
- 切 tab、窗口变化、字体变化时仍能正确调整远端 rows/cols。
- shell ready 后只发送最后一次 pending resize。

---

### 4.5 Phase 3：active terminal key 生命周期修复

#### 推荐方案

1. 注册 inputManager 时使用稳定 tab key，不使用初始为空的 SSH connectionId。
2. 如果必须用 connectionId，则 `connectionId` 为空时不注册、不 setActive。
3. `setActiveTerm('')` 改为 no-op debug，而非 warn。

#### 可选设计

| 方案 | 优点 | 风险 |
|---|---|---|
| 使用 `props.currentConnectionId` 作为 UI terminal key | 生命周期稳定，组件挂载时已有 | 需要确认外部发送命令是否依赖 SSH connectionId |
| 继续用 SSH connectionId，但注册延后到 connect success | 改动小 | 连接中无法作为 active terminal；reconnect 需重注册 |

推荐：**UI active terminal 使用 `props.currentConnectionId`，后端 SSH session 使用 `connectionId`。** 两个 ID 分层，避免 UI 生命周期与后端 session 生命周期互相污染。

#### 涉及文件

- `src/renderer/src/views/components/Ssh/utils/termInputManager.ts`
- `src/renderer/src/views/components/Ssh/sshConnect.vue`

#### 验收标准

- 日志中不再出现 `Failed to set, key not found` 且 key 为空。
- 全局输入栏/命令栏仍能向当前激活终端发送输入。
- reconnect 后 active terminal 不丢失。

---

### 4.6 Phase 4：JumpServer closeInfo 与自动重连

#### 推荐方案

将普通 SSH 的 close 分类机制抽出为共享 helper，JumpServer 分支也调用。

#### 当前普通 SSH 可复用能力

- `NETWORK_ERROR_CODES`
- `NETWORK_ERROR_PATTERNS`
- `recordSessionConnectionError()`
- `setPendingShellCloseInfo()`
- `consumeShellCloseInfo()`

#### 推荐改造

1. `conn.on('error')` / `stream.on('error')` 时记录 JumpServer session error。
2. `JumpServer shell stream close` 时：
   - `const closeInfo = consumeShellCloseInfo(id)`
   - 示例：<code>event.sender.send(`ssh:shell:close:${id}`, closeInfo)</code>
3. 手动 disconnect JumpServer 时也 set manual closeInfo。
4. 清理 maps 时同时清理 closeInfo 状态。

#### 涉及文件

- `src/main/ssh/sshHandle.ts`
- `src/main/ssh/jumpserver/connectionManager.ts`
- `src/main/ssh/jumpserver/interaction.ts`
- `src/main/ssh/jumpserver/state.ts`

#### 验收标准

- `read ETIMEDOUT` 后 renderer 日志显示 `isNetworkDisconnect: true`。
- auto reconnect 只在网络类断开触发，手动断开不触发。
- 普通 SSH 现有 reconnect 测试仍通过。

---

### 4.7 Phase 5：MFA / authentication UX 修复

#### 推荐方案

1. `submitOtpCode()` 提交后只设置 `isSubmitting = true`，不 reset dialog。
2. `handleOtpError(data)`：
   - `success`：reset dialog。
   - `failed` 且非 final：保持 dialog，显示错误，清空或选中输入以便重输。
   - `failed final`：显示最终失败后 reset/关闭。
3. 主进程错误分类细化：
   - `client-authentication` -> `auth.failed`
   - 若 keyboard-interactive 已触发且失败 -> `mfa.failed`
   - privateKey/password 不匹配 -> `auth.method.failed`，不要一律写 MFA。
4. 认证策略明确化：当 password 与 privateKey 同时存在时，使用 ssh2 `authHandler` 明确顺序，或至少日志记录 `authMethodSelected: publickey|password|keyboard-interactive`（不记录凭据）。

#### 涉及文件

- `src/renderer/src/components/global/mfa/mfaState.ts`
- `src/main/ssh/jumpserver/mfa.ts`
- `src/main/ssh/jumpserver/connectionManager.ts`
- `src/main/ssh/sshHandle.ts`（如果复用普通 SSH auth 分类）

#### 验收标准

- OTP 错误后用户能在同一个弹窗重试。
- 日志不再把所有认证失败都写成 MFA failed。
- 当 `currentOtpId` 不匹配时有 debug，但不造成用户不可见失败。

---

## 5. 推荐任务拆分

### Task A：JumpServer exec 串行队列（最高优先级）

- Owner：main process / JumpServer stream manager
- 修改：`streamManager.ts`, `state.ts`, `interaction.ts`, `sshHandle.ts`
- 测试：新增 `streamManager.queue.test.ts`
- 风险：解析逻辑涉及交互式输出，需保证 listener cleanup 不泄漏

### Task B：resize gate 与 pending flush

- Owner：renderer terminal lifecycle + main resize handler
- 修改：`sshConnect.vue`, `sshHandle.ts`
- 测试：renderer 单元测试或组件级 mock；主进程 handler 测试
- 风险：避免 suppress 掉真实 shell ready 后 resize

### Task C：JumpServer closeInfo

- Owner：main SSH close classification
- 修改：`sshHandle.ts`, `connectionManager.ts`, `interaction.ts`
- 测试：新增 JumpServer close classification tests
- 风险：不要破坏普通 SSH reconnect 既有测试

### Task D：MFA state machine

- Owner：global MFA component + connection manager auth classification
- 修改：`mfaState.ts`, `connectionManager.ts`, `mfa.ts`
- 测试：MFA state tests
- 风险：真实 ssh2 keyboard-interactive 可能多次触发，需要按 id 管理 listener

### Task E：active terminal key 分层

- Owner：renderer input manager
- 修改：`termInputManager.ts`, `sshConnect.vue`
- 测试：inputManager tests
- 风险：外部命令发送通道可能依赖 key，需要验证 command bar / AI suggest / global input

---

## 6. 验证方案

### 6.1 自动化验证

```bash
npm test -- src/main/ssh/jumpserver/__tests__/streamManager.queue.test.ts
npm test -- src/main/ssh/__tests__/sshHandle.reconnect.test.ts
npm test -- src/main/ssh/__tests__/sshHandle.jumpserver-close.test.ts
npm test -- src/renderer/src/views/components/Ssh/utils/__tests__/termInputManager.test.ts
npm test -- src/renderer/src/components/global/mfa/__tests__/mfaState.test.ts
npm run typecheck
```

### 6.2 手动验证

1. JumpServer 成功连接目标 Linux 资产。
2. 连接成功后观察 60 秒：
   - 无 `jumpserver.exec.timeout`
   - 无混合 marker 的 `pidResult.stdout`
   - command list / system info / shell PID 都能独立完成或独立失败。
3. 快速拖拽窗口 / 切 tab / 改字体：
   - 无初始化阶段 `Resize failed`
   - shell ready 后 resize 生效。
4. 模拟网络断开：
   - JumpServer renderer close classification 为 `isNetworkDisconnect: true`
   - 自动重连进入预期流程。
5. OTP 输入错误：
   - 弹窗保留并提示错误
   - 可重输
   - 第 3 次或 final failure 后关闭并显示连接失败。

### 6.3 观测指标

| 指标 | 期望 |
|---|---|
| `jumpserver.exec.timeout` | 修复后连接成功后 0 次，除非远端命令真实卡住 |
| `Resize failed` | 初始化阶段 0 次 |
| `Failed to set, key not found` | key 为空场景 0 次 warn |
| `ssh.shell.close.classify.renderer` | ETIMEDOUT 场景 `isNetworkDisconnect: true` |
| MFA `currentOtpId:null` 失败结果 | 显著减少；失败结果应在 dialog 生命周期内处理 |

---

## 7. 风险与回滚

| 风险 | 缓解 | 回滚 |
|---|---|---|
| exec 队列引入死锁 | timeout 后 finally 必须释放；测试覆盖 timeout 后继续执行 | 切回旧 `executeCommandOnJumpServerExec` 调用 |
| resize gate 导致远端尺寸不更新 | latest pending resize + shell ready flush；手动验证 | 恢复直接 resize，但降低日志级别 |
| closeInfo 改造影响普通 SSH | 抽 helper 前先跑现有 reconnect tests | 保留普通 SSH 路径不动，仅 JumpServer 单独实现 |
| MFA 弹窗不关闭 | success/final failure 明确 reset；超时仍 reset | 恢复提交后 reset，但保留失败 result 兼容处理 |
| active key 分层影响全局输入 | 保持 UI tab key 到 backend connectionId 的映射 | 仅对空 key no-op，不做 key 分层 |

---

## 8. 最终 ADR

### Decision

采用 **JumpServer exec 串行队列 + resize readiness gate + JumpServer closeInfo 补齐 + MFA 状态机修复** 的分阶段方案。

### Drivers

1. 日志根因最强证据是 exec 输出串台，必须先解决。
2. resize/key warning 是前端生命周期问题，应通过状态 gate 降噪。
3. ETIMEDOUT 不进入重连是缺失 closeInfo，不是网络检测本身失败。
4. MFA 失败体验受 UI 过早 reset 影响，需按 ssh2 keyboard-interactive 多次触发模型处理。

### Alternatives considered

1. **每条 JumpServer 命令都创建新 shell stream**  
   - Rejected：开销大，仍需导航目标资产；并发创建多个 shell 也会增加 JumpServer 负担。
2. **完全移除 command list/system info/PID 探测**  
   - Rejected：能止血，但会损失 AI 建议、cwd、命令能力上下文。
3. **只提高 timeout 到 60s/120s**  
   - Rejected：无法解决输出串台根因，只会延迟失败。
4. **把 resize 失败日志降级为 debug**  
   - Rejected：只掩盖症状，不修复过早发送 resize。

### Why chosen

该方案最小化改动范围，并对每个日志问题都有直接因果修复：

- exec timeout -> 队列
- resize failed -> ready gate
- key not found -> stable UI key/no-op
- ETIMEDOUT misclassification -> closeInfo
- MFA failure UX -> 状态机

### Consequences

- JumpServer 命令探测会从并发变为串行，连接后 command list/system info/PID 总耗时可能略增加，但稳定性显著提高。
- 需要新增多组单元测试和少量状态字段。
- 日志会更结构化，便于后续定位真实认证失败 vs 网络失败。

### Follow-ups

1. 后续可评估把 JumpServer command list 延迟到首次 AI suggest，而不是连接成功即执行。
2. 后续可将 `connectionId` 与 UI tab id 的关系整理成统一 session model。
3. 后续可增加 JumpServer 版本/KoKo 组件兼容矩阵。

---

## 9. 执行建议

建议后续按 `$ralph` 单 owner 或 `$team` 多 lane 实施：

- 单 owner：先做 Task A+B+C，跑测试，再做 D+E。
- 多 lane：
  - Lane 1：JumpServer exec queue
  - Lane 2：renderer resize/input lifecycle
  - Lane 3：closeInfo/MFA tests and implementation
  - Leader 最后统一跑 typecheck/test，并手动验证 JumpServer。

建议不要在同一个 PR 中混入无关数据库、UI 样式或依赖升级改动。
