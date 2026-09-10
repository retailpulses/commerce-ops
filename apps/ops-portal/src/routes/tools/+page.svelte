<style>
  h1 {
    margin-bottom: 0.5rem;
  }
  .tools {
    margin-top: 1.5rem;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
  }
  .tool {
    display: block;
    padding: 1.5rem;
    border: 1px solid var(--color-border);
    border-radius: 12px;
    background: var(--color-surface);
    color: var(--color-text);
  }
  .tool h2 {
    font-size: 1.2rem;
  }
  .tool p {
    margin: 0.75rem 0;
  }
  .tool span {
    color: var(--color-primary);
  }
</style>

<script>
  import { resolve } from '$app/paths';
  import { tools } from '$lib/tools/products.js';
</script>

<svelte:head><title>Tools — Ops Portal</title></svelte:head>
<h1>Tools</h1>
<p>Operator tools for product master business values.</p>
<div class="tools">
  {#each tools as tool (tool.href)}
    <a class="tool" href={resolve(tool.href)}
      ><h2>{tool.name}</h2>
      <p>{tool.description}</p>
      <span>Open tool →</span></a
    >
  {/each}
</div>
