<style>
  .chat-message {
    display: flex;
    flex-direction: column;
    margin-bottom: var(--spacing-md);
    max-width: 85%;
  }

  .chat-message--user {
    align-self: flex-end;
    align-items: flex-end;
  }

  .chat-message--assistant {
    align-self: flex-start;
    align-items: flex-start;
  }

  .chat-message__label {
    font-size: 0.75rem;
    color: var(--color-text-muted);
    margin-bottom: var(--spacing-xs);
    padding: 0 var(--spacing-sm);
  }

  .chat-message__bubble {
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--radius-md);
    line-height: 1.5;
  }

  .chat-message--user .chat-message__bubble {
    background: var(--color-primary);
    color: #fff;
  }

  .chat-message--assistant .chat-message__bubble {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    box-shadow: var(--shadow-sm);
  }

  .chat-message__content {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .chat-message__citations {
    margin-top: var(--spacing-sm);
    padding-top: var(--spacing-sm);
    border-top: 1px solid var(--color-border);
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs);
    align-items: center;
  }

  .chat-message--user .chat-message__citations {
    border-top-color: rgba(255, 255, 255, 0.25);
  }

  .citations-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
  }

  .citation-chip {
    display: inline-block;
    font-size: 0.7rem;
    padding: 2px var(--spacing-xs);
    background: var(--color-bg);
    border-radius: var(--radius-sm);
    opacity: 0.8;
    white-space: nowrap;
  }

  .chat-message--user .citation-chip {
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
  }
</style>

<script>
  /**
   * @type {{ role: 'user'|'assistant', content: string, citations?: Array<{type:string, id:string, file?:string}>, [key:string]: any }}
   */
  let { role = 'user', content = '', citations = [] } = $props();
</script>

<div class="chat-message chat-message--{role}">
  <div class="chat-message__label">{role === 'user' ? 'You' : 'Assistant'}</div>
  <div class="chat-message__bubble">
    <div class="chat-message__content">{content}</div>
    {#if citations.length > 0}
      <div class="chat-message__citations">
        <span class="citations-label">Sources:</span>
        {#each citations as cite (`${cite.type}:${cite.id}:${cite.file ?? ''}`)}
          <span class="citation-chip">
            {cite.type === 'repo' ? '📁' : cite.type === 'skill' ? '⚡' : '🏷️'}
            {cite.id}{cite.file ? ` (${cite.file})` : ''}
          </span>
        {/each}
      </div>
    {/if}
  </div>
</div>
