import { installRemoteApi } from './remoteApi'

installRemoteApi()
// Dynamic import so the shim is guaranteed to exist before the app's top-level code runs.
void import('../main')
