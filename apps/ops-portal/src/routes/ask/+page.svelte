<style>
  .ask-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - var(--header-height) - var(--spacing-2xl));
    max-width: 800px;
    margin: 0 auto;
  }

  .ask-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: var(--spacing-lg) 0;
    flex-shrink: 0;
  }

  .ask-header h1 {
    margin: 0 0 var(--spacing-xs) 0;
  }

  .ask-chat {
    flex: 1;
    overflow-y: auto;
    padding: var(--spacing-md) 0;
    display: flex;
    flex-direction: column;
  }

  .ask-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: var(--spacing-2xl);
  }

  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm);
    justify-content: center;
    margin-top: var(--spacing-md);
    max-width: 550px;
  }

  .suggestion-chip {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full, 1.25rem);
    padding: var(--spacing-xs) var(--spacing-md);
    font-size: var(--font-size-sm);
    color: var(--color-text);
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s;
    white-space: nowrap;
  }

  .suggestion-chip:hover {
    background: var(--color-surface);
    border-color: var(--color-primary);
  }

  .ask-footer {
    flex-shrink: 0;
  }

  .status-line {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    background: var(--color-bg);
  }

  .spinner-sm {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing-md);
    padding: var(--spacing-sm) var(--spacing-md);
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: var(--radius-md);
    color: #991b1b;
    font-size: var(--font-size-sm);
    margin: 0 var(--spacing-md) var(--spacing-sm);
  }

  .error-actions {
    display: flex;
    gap: var(--spacing-xs);
    flex-shrink: 0;
  }

  .btn-ghost {
    background: transparent;
    border: 1px solid var(--color-border);
    color: var(--color-text);
  }

  .btn-ghost:hover {
    background: var(--color-bg);
  }

  @media (max-width: 768px) {
    .ask-page {
      height: calc(100vh - var(--header-height));
      max-width: 100%;
      padding: 0 var(--spacing-md);
    }

    .ask-header {
      flex-direction: column;
      gap: var(--spacing-sm);
      padding: var(--spacing-md) 0;
    }

    .suggestions {
      flex-direction: column;
      align-items: stretch;
    }

    .error-banner {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>

<script>
  import { askQuestion } from '$lib/utils/ask.js';
  import ChatMessage from '$lib/components/ChatMessage.svelte';
  import ChatInput from '$lib/components/ChatInput.svelte';

  const SUGGESTED_QUESTIONS = [
    'What repos do we have?',
    'Which skills are installed?',
    'Show me Mercari-related items',
    'What does the OrderMgmt repo do?',
    'How does the baserow-database-manager skill work?',
    'Which Python repos exist?'
  ];

  const STORAGE_KEY = 'ops-portal-ask-history';
  const MAX_STORED_MESSAGES = 30;

  /** @type {Array<{role:string, content:string, citations?:Array}>} */
  let messages = $state([]);
  let loading = $state(false);
  let error = $state(null);
  let currentContent = $state('');
  let statusLine = $state('');
  let currentCitations = $state([]);
  let scrollEl = $state(null);
  let currentAbort = $state(null);

  // Load persisted history on mount
  $effect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          messages = parsed.slice(-MAX_STORED_MESSAGES);
        }
      }
    } catch {}
  });

  // Persist history on change
  $effect(() => {
    if (messages.length > 0) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)));
      } catch {}
    }
  });

  // Auto-scroll
  $effect(() => {
    if (scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });

  function handleSubmit(text) {
    if (!text || loading) return;

    error = null;
    currentContent = '';
    currentCitations = [];
    statusLine = 'Sending...';
    loading = true;

    // Add user message
    messages.push({ role: 'user', content: text });

    const active = askQuestion(text, messages.slice(0, -1), {
      onStatus(msg) {
        statusLine = msg;
      },
      onRetrieval(data) {
        const parts = [];
        if (data.repoCount > 0) parts.push(`${data.repoCount} repos`);
        if (data.skillCount > 0) parts.push(`${data.skillCount} skills`);
        if (data.domainCount > 0) parts.push(`${data.domainCount} domains`);
        statusLine = `Found ${parts.join(', ') || 'no matches'} — asking AI...`;
      },
      onToolStart(data) {
        if (data.tool === 'read_repo_doc') {
          statusLine = `Reading ${data.args.repoId}/${data.args.docKey}...`;
        } else if (data.tool === 'read_skill_file') {
          statusLine = `Reading skill: ${data.args.skillId}...`;
        }
      },
      onToolResult(data) {
        if (data.status === 'ok') {
          statusLine = `Got document (${data.bytes} bytes) — generating answer...`;
        } else {
          statusLine = `Document fetch failed — continuing...`;
        }
      },
      onToken(text) {
        currentContent += text;
      },
      onFinal(data) {
        messages.push({
          role: 'assistant',
          content: data.content || currentContent,
          citations: data.citations || []
        });
        currentContent = '';
        currentCitations = [];
        statusLine = '';
        loading = false;
      },
      onError(data) {
        error = data;
        statusLine = '';
        loading = false;
        // If we have partial content, save it
        if (currentContent) {
          messages.push({
            role: 'assistant',
            content: currentContent + '\n\n[Answer incomplete due to error]',
            citations: currentCitations
          });
          currentContent = '';
          currentCitations = [];
        }
      }
    });

    currentAbort = { abort: active.abort };
  }

  function handleCancel() {
    currentAbort?.abort();
    loading = false;
    statusLine = '';
    if (currentContent) {
      messages.push({
        role: 'assistant',
        content: currentContent + '\n\n[Answer cancelled]',
        citations: currentCitations
      });
      currentContent = '';
      currentCitations = [];
    }
  }

  function handleNewChat() {
    messages = [];
    currentContent = '';
    currentCitations = [];
    error = null;
    statusLine = '';
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  function handleRetry() {
    if (messages.length === 0) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) {
      // Remove everything after the last user message
      const idx = messages.lastIndexOf(lastUser);
      messages = messages.slice(0, idx);
      handleSubmit(lastUser.content);
    }
  }

  function handleSuggestionClick(q) {
    handleSubmit(q);
  }
</script>

<svelte:head>
  <title>Ask — Ops Portal</title>
</svelte:head>

<div class="ask-page">
  <div class="ask-header">
    <div>
      <h1>Ask about the portal</h1>
      <p class="text-sm text-muted">
        Ask questions about repos, skills, domains, and URLs in natural language.
      </p>
    </div>
    {#if messages.length > 0}
      <button class="btn btn-sm" onclick={handleNewChat}>New chat</button>
    {/if}
  </div>

  <div class="ask-chat" bind:this={scrollEl}>
    {#if messages.length === 0}
      <div class="ask-empty">
        <p class="text-muted">Ask anything about the Ops Portal catalog. For example:</p>
        <div class="suggestions">
          {#each SUGGESTED_QUESTIONS as q (q)}
            <button class="suggestion-chip" onclick={() => handleSuggestionClick(q)}>{q}</button>
          {/each}
        </div>
        <p class="text-sm text-muted" style="margin-top: var(--spacing-lg)">
          You can also ask about specific repo contents (e.g., README, AGENTS.md) or skill
          definitions.
        </p>
      </div>
    {:else}
      {#each messages as msg, index (`${index}:${msg.role}:${msg.content}`)}
        <ChatMessage role={msg.role} content={msg.content} citations={msg.citations || []} />
      {/each}

      {#if loading && currentContent}
        <ChatMessage role="assistant" content={currentContent} citations={currentCitations} />
      {/if}
    {/if}
  </div>

  <div class="ask-footer">
    {#if statusLine}
      <div class="status-line">
        <span class="spinner-sm"></span>
        {statusLine}
        <button class="btn btn-sm btn-ghost" onclick={handleCancel}>Cancel</button>
      </div>
    {/if}

    {#if error}
      <div class="error-banner">
        <span>{error.message || 'An error occurred'}</span>
        <div class="error-actions">
          <button class="btn btn-sm" onclick={handleRetry}>Retry</button>
          <button class="btn btn-sm btn-ghost" onclick={() => (error = null)}>Dismiss</button>
        </div>
      </div>
    {/if}

    <ChatInput onsubmit={handleSubmit} {loading} />
  </div>
</div>
