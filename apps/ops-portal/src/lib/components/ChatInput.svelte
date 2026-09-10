<style>
  .chat-input {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    padding: var(--spacing-md);
    background: var(--color-surface);
    border-top: 1px solid var(--color-border);
    position: relative;
  }

  .chat-input__field {
    flex: 1;
    padding: var(--spacing-sm) var(--spacing-md);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    font-size: var(--font-size-base);
    font-family: inherit;
    background: var(--color-bg);
    color: var(--color-text);
    outline: none;
    transition: border-color 0.15s;
  }

  .chat-input__field:focus {
    border-color: var(--color-primary);
  }

  .chat-input__field:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .chat-input__send {
    white-space: nowrap;
    min-width: 64px;
  }

  .chat-input__count {
    font-size: 0.7rem;
    color: var(--color-text-muted);
    position: absolute;
    right: var(--spacing-lg);
    bottom: 4px;
  }

  .chat-input__count--warn {
    color: var(--color-workspace, #d97706);
  }

  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

<script>
  /** @type {{ disabled?: boolean, loading?: boolean, onsubmit?: (text: string) => void }} */
  let { disabled = false, loading = false, onsubmit } = $props();

  let input = $state('');
  let inputEl = $state(null);

  function handleSubmit() {
    const text = input.trim();
    if (!text || disabled || loading) return;
    onsubmit?.(text);
    input = '';
    inputEl?.focus();
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }
</script>

<div class="chat-input">
  <input
    type="text"
    bind:value={input}
    bind:this={inputEl}
    onkeydown={handleKeydown}
    placeholder="Ask about the portal..."
    disabled={disabled || loading}
    maxlength="500"
    class="chat-input__field"
    aria-label="Ask a question"
  />
  <button
    class="chat-input__send btn"
    onclick={handleSubmit}
    disabled={disabled || loading || !input.trim()}
    aria-label="Send"
  >
    {#if loading}
      <span class="spinner"></span>
    {:else}
      Send
    {/if}
  </button>
  {#if input.length > 400}
    <span class="chat-input__count" class:chat-input__count--warn={input.length > 480}>
      {input.length}/500
    </span>
  {/if}
</div>
