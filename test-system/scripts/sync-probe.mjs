// Diagnostic probe of the official HTTP sync protocol, not a client database.
// Protocol: powersync-service/packages/service-core/src/util/protocol-types.ts.
export async function waitForWidget(response, id, name) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) {
    throw new Error(`Cloud sync did not return NDJSON (HTTP ${response.status}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let found = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Cloud stream ended before the widget and its completed checkpoint arrived.');
      buffered += decoder.decode(value, { stream: true });
      if (buffered.length > 8 * 1024 * 1024) throw new Error('Cloud sync line exceeded the diagnostic size limit.');
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const text = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!text) continue;
        const line = JSON.parse(text);
        if (line.error || line.checkpoint?.streams?.some(stream => stream.errors?.length)) {
          throw new Error('Cloud reported a sync error or unresolved stream subscription.');
        }
        for (const operation of line.data?.data ?? []) {
          if (operation.object_type !== 'widgets' || operation.object_id !== id || operation.op !== 'PUT') continue;
          const data = typeof operation.data === 'string' ? JSON.parse(operation.data) : operation.data;
          if (data?.name === name) found = true;
        }
        if (found && line.checkpoint_complete) return;
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export function syncRequest(token, signal) {
  return {
    method: 'POST', signal,
    headers: { authorization: `Token ${token}`, 'content-type': 'application/json', accept: 'application/x-ndjson',
      'x-user-agent': 'powersync-test-system/phase-3' },
    body: JSON.stringify({ buckets: [], raw_data: true, include_checksum: true,
      streams: { include_defaults: true, subscriptions: [] } })
  };
}
