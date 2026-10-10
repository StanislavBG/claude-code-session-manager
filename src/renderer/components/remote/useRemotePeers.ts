import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '../../state/toast'
import type { RemoteMachinePeer, RemoteClientStatus } from '../../../preload/api'

const errMsg = (e: unknown) => (e as Error)?.message || String(e)

export interface RemotePeers {
  peers: RemoteMachinePeer[]
  refresh(): Promise<void>
  connect(peerId: string): Promise<void>
  confirmSas(peerId: string): Promise<void>
  revoke(peerId: string): Promise<void>
}

/** Paired remote machines: list, live status subscription, connect / SAS / revoke. Shared by Settings and the Remote view. */
export function useRemotePeers(onStatusEvent?: (s: RemoteClientStatus) => void): RemotePeers {
  const showToast = useToast((s) => s.show)
  const [peers, setPeers] = useState<RemoteMachinePeer[]>([])
  const statusCb = useRef(onStatusEvent)
  statusCb.current = onStatusEvent

  const refresh = useCallback(async () => {
    try {
      setPeers(await window.api.remoteClient.list())
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast])

  useEffect(() => {
    void refresh()
    const unsub = window.api.remoteClient.onStatus((s: RemoteClientStatus) => {
      statusCb.current?.(s)
      setPeers((prev) => prev.map((p) => (p.peerId === s.peerId ? { ...p, status: s.status, reason: s.reason, sas: s.sas } : p)))
    })
    return () => { unsub() }
  }, [refresh])

  const connect = useCallback(async (peerId: string) => {
    try {
      const r = await window.api.remoteClient.connect(peerId)
      setPeers((prev) => prev.map((p) => (p.peerId === peerId ? { ...p, status: r.status, reason: r.reason, sas: r.sas } : p)))
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast])

  const confirmSas = useCallback(async (peerId: string) => {
    try {
      const r = await window.api.remoteClient.confirmSas(peerId)
      if (!r.ok) showToast('error', r.reason ?? 'SAS confirmation failed')
      await refresh()
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast, refresh])

  const revoke = useCallback(async (peerId: string) => {
    try {
      await window.api.remoteClient.remove(peerId)
      await refresh()
    } catch (e) {
      showToast('error', errMsg(e))
    }
  }, [showToast, refresh])

  return { peers, refresh, connect, confirmSas, revoke }
}
