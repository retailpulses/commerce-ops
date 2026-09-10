/**
 * Streaming client for the Ops Portal Ask API.
 * POSTs to /api/ask and parses typed SSE events.
 *
 * @param {string} question
 * @param {Array<{role:string, content:string, citations?:Array}>} history
 * @param {object} callbacks
 * @param {(msg:string)=>void} callbacks.onStatus
 * @param {(data:{matched:string[], repoCount:number, skillCount:number, domainCount:number})=>void} callbacks.onRetrieval
 * @param {(data:{tool:string, args:object})=>void} callbacks.onToolStart
 * @param {(data:{tool:string, status:string, bytes?:number, error?:string})=>void} callbacks.onToolResult
 * @param {(text:string)=>void} callbacks.onToken
 * @param {(data:{content:string, citations:Array, toolRounds:number, docReads:number})=>void} callbacks.onFinal
 * @param {(data:{code:string, message:string, detail?:string})=>void} callbacks.onError
 * @returns {{ abort: ()=>void }}
 */
export function askQuestion(question, history, callbacks) {
  const abortController = new AbortController();

  const run = async () => {
    let streamEndedCleanly = false;
    const STREAM_TIMEOUT_MS = 60_000;
    let timedOut = false;

    // Safety net: abort if no terminal event within 60s
    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, STREAM_TIMEOUT_MS);

    try {
      // Prepare history without citations for server
      const serverHistory = history.map(({ role, content }) => ({ role, content }));

      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), history: serverHistory }),
        signal: abortController.signal
      });

      if (!res.ok) {
        let errorData = { code: 'http_error', message: `Server error (${res.status})` };
        try {
          const json = await res.json();
          if (json.error) errorData = { code: json.error, message: json.message || json.error };
        } catch {}
        callbacks.onError?.(errorData);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = ''; // MUST persist across while-loop iterations — chunks can split event/data lines

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE frames
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // incomplete line stays in buffer

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            try {
              const data = JSON.parse(dataStr);
              if (currentEvent === 'final' || currentEvent === 'error') {
                streamEndedCleanly = true;
              }
              dispatchEvent(currentEvent, data, callbacks);
            } catch {
              // Skip malformed JSON lines
            }
            currentEvent = '';
          }
          // Empty lines are SSE separators — ignore
        }
      }

      // Process any remaining buffer — reuse currentEvent from main loop, don't start fresh
      if (buffer.trim()) {
        const lines2 = buffer.split('\n');
        for (const line of lines2) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'final' || currentEvent === 'error') {
                streamEndedCleanly = true;
              }
              dispatchEvent(currentEvent, data, callbacks);
            } catch {}
          }
        }
      }

      // If the stream ended without a final or error event, something went wrong
      if (!streamEndedCleanly) {
        callbacks.onError?.({
          code: 'stream_ended',
          message:
            'The response ended unexpectedly. The server may have timed out. Please try again.'
        });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        if (timedOut) {
          callbacks.onError?.({
            code: 'stream_timeout',
            message: 'The response took too long. The server may be busy. Please try again.'
          });
        }
        return;
      }
      callbacks.onError?.({
        code: 'network_error',
        message: err.message || 'Network error. Check your connection.'
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  run();

  return {
    abort() {
      abortController.abort();
    }
  };
}

/**
 * @param {string} event
 * @param {object} data
 * @param {object} callbacks
 */
function dispatchEvent(event, data, callbacks) {
  switch (event) {
    case 'status':
      callbacks.onStatus?.(data.message || '');
      break;
    case 'retrieval':
      callbacks.onRetrieval?.(data);
      break;
    case 'tool_start':
      callbacks.onToolStart?.(data);
      break;
    case 'tool_result':
      callbacks.onToolResult?.(data);
      break;
    case 'token':
      callbacks.onToken?.(data.text || '');
      break;
    case 'final':
      callbacks.onFinal?.(data);
      break;
    case 'error':
      callbacks.onError?.(data);
      break;
  }
}
