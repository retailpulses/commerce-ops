<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: var(--spacing-lg);
  }

  .modal-card {
    width: 100%;
    max-width: 520px;
    max-height: 90vh;
    overflow-y: auto;
    padding: var(--spacing-xl);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--spacing-lg);
  }

  .modal-header h2 {
    font-size: var(--font-size-xl);
  }

  .modal-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    color: var(--color-text-muted);
    padding: 0 var(--spacing-xs);
    line-height: 1;
  }

  .modal-close:hover {
    color: var(--color-text);
  }

  .modal-form {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
  }

  .modal-form label {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .modal-form span {
    font-size: var(--font-size-xs);
    color: var(--color-text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .modal-form input,
  .modal-form select,
  .modal-form textarea {
    width: 100%;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  .modal-form textarea {
    resize: vertical;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
  }

  .checkbox-row input[type='checkbox'] {
    width: auto;
    padding: 0;
  }

  .form-error {
    color: #b91c1c;
    font-size: var(--font-size-sm);
  }

  .modal-actions {
    display: flex;
    gap: var(--spacing-sm);
    margin-top: var(--spacing-sm);
  }
</style>

<script>
  let {
    show = false,
    title = 'Edit',
    fields = [],
    data = {},
    onsave = () => {},
    onclose = () => {}
  } = $props();

  let formData = $state({});
  let error = $state('');

  $effect(() => {
    if (show) {
      formData = { ...data };
      error = '';
    }
  });

  function handleSubmit(e) {
    e.preventDefault();
    error = '';
    for (const f of fields) {
      if (f.required && !formData[f.key]?.toString().trim()) {
        error = `${f.label} is required.`;
        return;
      }
    }
    onsave({ ...formData });
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

{#if show}
  <div class="modal-backdrop" onclick={handleBackdrop}>
    <div class="modal-card card">
      <div class="modal-header">
        <h2>{title}</h2>
        <button class="modal-close" onclick={onclose} aria-label="Close">&times;</button>
      </div>

      <form class="modal-form" onsubmit={handleSubmit}>
        {#each fields as f (f.key)}
          <label>
            <span>{f.label}</span>
            {#if f.type === 'textarea'}
              <textarea bind:value={formData[f.key]} rows="4" placeholder={f.placeholder ?? ''}
              ></textarea>
            {:else if f.type === 'select'}
              <select bind:value={formData[f.key]}>
                {#each f.options ?? [] as opt (opt.value ?? opt)}
                  <option value={opt.value ?? opt}>{opt.label ?? opt}</option>
                {/each}
              </select>
            {:else if f.type === 'checkbox'}
              <div class="checkbox-row">
                <input
                  type="checkbox"
                  checked={formData[f.key] ?? false}
                  onchange={(e) => (formData[f.key] = e.target.checked)}
                />
                <span class="text-sm text-muted">{f.placeholder ?? ''}</span>
              </div>
            {:else}
              <input bind:value={formData[f.key]} type="text" placeholder={f.placeholder ?? ''} />
            {/if}
          </label>
        {/each}

        {#if error}
          <p class="form-error">{error}</p>
        {/if}

        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Save</button>
          <button type="button" class="btn" onclick={onclose}>Cancel</button>
        </div>
      </form>
    </div>
  </div>
{/if}
