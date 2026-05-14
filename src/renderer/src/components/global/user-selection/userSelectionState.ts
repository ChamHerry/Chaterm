import { ref } from 'vue'

const logger = createRendererLogger('userSelection')

// User selection dialog state
export const showUserSelectionDialog = ref(false)
export const userSelectionError = ref(false)
export const userList = ref<Array<{ id: number; name: string; username: string }>>([])
export const selectedUserId = ref<number | null>(null)
export const currentConnectionId = ref<string | null>(null)
export const currentTargetAssetUuid = ref<string | null>(null)
export const userSelectionTimeRemaining = ref(0)
export const isSubmitting = ref(false)
export const rememberSelection = ref(false)

// Constants
const USER_SELECTION_TIMEOUT = 30000 // 30 seconds

let userSelectionTimerInterval: NodeJS.Timeout | null = null

// Start user selection timer
const startUserSelectionTimer = (durationMs = USER_SELECTION_TIMEOUT) => {
  if (userSelectionTimerInterval) {
    clearInterval(userSelectionTimerInterval)
  }
  const endTime = Date.now() + durationMs
  userSelectionTimeRemaining.value = durationMs
  userSelectionTimerInterval = setInterval(() => {
    const remaining = endTime - Date.now()
    if (remaining <= 0) {
      if (userSelectionTimerInterval !== null) {
        clearInterval(userSelectionTimerInterval)
      }
      userSelectionTimeRemaining.value = 0
      showUserSelectionDialog.value = false
      cancelUserSelection()
    } else {
      userSelectionTimeRemaining.value = remaining
    }
  }, 1000)
}

// Reset error state
const resetErrors = () => {
  userSelectionError.value = false
}

// Reset user selection dialog state
export const resetUserSelectionDialog = () => {
  logger.info('Reset user selection dialog state')
  showUserSelectionDialog.value = false
  userSelectionError.value = false
  userList.value = []
  selectedUserId.value = null
  currentConnectionId.value = null
  currentTargetAssetUuid.value = null
  isSubmitting.value = false
  rememberSelection.value = false
  // Clear timer
  if (userSelectionTimerInterval) {
    clearInterval(userSelectionTimerInterval)
    userSelectionTimerInterval = null
  }
}

// Handle user selection request from main process
export const handleUserSelectionRequest = (data: any) => {
  logger.info('Received user selection request', { id: data.id, userCount: data.users?.length })

  currentConnectionId.value = data.id
  currentTargetAssetUuid.value = data.targetAssetUuid || null
  rememberSelection.value = false
  userList.value = data.users || []
  // Automatically select the first user by default
  selectedUserId.value = userList.value.length > 0 ? userList.value[0].id : null
  showUserSelectionDialog.value = true
  resetErrors()
  startUserSelectionTimer()
}

// Handle user selection timeout
export const handleUserSelectionTimeout = (data: any) => {
  if (data.id === currentConnectionId.value && showUserSelectionDialog.value) {
    logger.info('User selection timeout')
    resetUserSelectionDialog()
  }
}

// Handle user selection (row click)
export const handleUserSelect = (userId: number) => {
  logger.info('User selected', { userId })
  selectedUserId.value = userId
  resetErrors()
}

// Submit user selection
export const submitUserSelection = async () => {
  logger.info('Attempting to submit user selection', { selectedUserId: selectedUserId.value })

  // Reset error state
  resetErrors()

  // Validate input
  if (selectedUserId.value === null) {
    logger.debug('No user selected')
    userSelectionError.value = true
    return
  }

  if (!currentConnectionId.value) {
    logger.debug('No current connection ID')
    userSelectionError.value = true
    return
  }

  if (isSubmitting.value) {
    logger.debug('Already submitting, ignoring duplicate request')
    return
  }

  try {
    isSubmitting.value = true
    const connectionId = currentConnectionId.value
    const userId = selectedUserId.value
    const selectedUser = userList.value.find((user) => user.id === userId)
    const targetAssetUuid = currentTargetAssetUuid.value
    const shouldRememberSelection = rememberSelection.value

    logger.info('Submitting user selection', { connectionId, userId })

    const api = (window as any).api
    await api.sendUserSelectionResponse(connectionId, userId)

    logger.info('User selection submitted successfully')
    if (shouldRememberSelection && targetAssetUuid && selectedUser) {
      void api
        .updateOrganizationAsset({
          uuid: targetAssetUuid,
          loginUsername: selectedUser.username,
          loginUserName: selectedUser.name
        })
        .catch((error: unknown) => {
          logger.warn('Failed to remember JumpServer user selection', {
            hasTargetAssetUuid: true,
            errorMessage: error instanceof Error ? error.message : String(error)
          })
        })
    }
    // Close dialog after successful submission
    resetUserSelectionDialog()
  } catch (error) {
    logger.error('Failed to submit user selection', { errorMessage: error instanceof Error ? error.message : String(error) })
    userSelectionError.value = true
    isSubmitting.value = false
  }
}

// Cancel user selection
export const cancelUserSelection = () => {
  if (currentConnectionId.value) {
    logger.info('Cancelling user selection', { connectionId: currentConnectionId.value })
    const api = (window as any).api
    api.sendUserSelectionCancel(currentConnectionId.value)
    resetUserSelectionDialog()
  }
}
