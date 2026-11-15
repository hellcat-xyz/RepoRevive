'use client';

import { useCallback, useEffect, useState } from 'react';

export interface GithubStatus {
  loading: boolean;
  configured: boolean;
  connected: boolean;
  connectionStatus?: string;
  user?: { login: string; avatarUrl: string | null };
  installUrl?: string | null;
}

/** Connection state from the server. Tokens never reach the browser; this only reports who is connected. */
export function useGithub() {
  const [status, setStatus] = useState<GithubStatus>({ loading: true, configured: false, connected: false });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/github/status', { cache: 'no-store' });
      const body = (await res.json()) as Omit<GithubStatus, 'loading'>;
      setStatus({ ...body, loading: false });
    } catch {
      setStatus({ loading: false, configured: false, connected: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disconnect = useCallback(async () => {
    const res = await fetch('/api/github/disconnect', { method: 'POST' });
    await refresh();
    return res.ok;
  }, [refresh]);

  return { status, refresh, disconnect };
}
