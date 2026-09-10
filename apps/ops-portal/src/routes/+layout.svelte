<style>
  .layout {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  .layout-body {
    display: flex;
    gap: var(--spacing-xl);
    flex: 1;
  }

  .main-content {
    flex: 1;
    min-width: 0;
    padding: var(--spacing-xl) 0;
  }

  .metrics-layout .main-content {
    max-width: 1200px;
    margin: 0 auto;
  }

  @media (max-width: 768px) {
    .layout-body {
      gap: 0;
    }
  }
</style>

<script>
  import { page } from '$app/state';
  import '../app.css';
  import Header from '$lib/components/Header.svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Footer from '$lib/components/Footer.svelte';

  let { children } = $props();
</script>

<div class="layout">
  <Header />

  <div class:metrics-layout={page.url.pathname === '/'} class="layout-body container">
    {#if page.url.pathname !== '/' && !page.url.pathname.startsWith('/tools')}
      <Sidebar />
    {/if}
    <main class="main-content">
      {@render children()}
    </main>
  </div>

  <Footer />
</div>
