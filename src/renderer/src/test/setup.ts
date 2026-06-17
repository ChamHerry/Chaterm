const hasStorageApi = (storage: unknown): storage is Storage => {
  return (
    !!storage &&
    typeof (storage as Storage).getItem === 'function' &&
    typeof (storage as Storage).setItem === 'function' &&
    typeof (storage as Storage).removeItem === 'function' &&
    typeof (storage as Storage).clear === 'function'
  )
}

const createMemoryStorage = (): Storage => {
  const entries = new Map<string, string>()

  return {
    get length() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
    getItem(key: string) {
      return entries.get(String(key)) ?? null
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null
    },
    removeItem(key: string) {
      entries.delete(String(key))
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value))
    }
  } as Storage
}

if (!hasStorageApi(globalThis.localStorage)) {
  const storage = createMemoryStorage()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  })

  if (globalThis.window) {
    Object.defineProperty(globalThis.window, 'localStorage', {
      configurable: true,
      value: storage
    })
  }
}
