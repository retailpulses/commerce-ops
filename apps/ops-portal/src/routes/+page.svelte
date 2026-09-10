<style>
  .metrics-shell,
  .commercial-shell {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--spacing-lg);
  }

  .metrics-heading,
  .section-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .metrics-heading select {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: white;
  }

  .metrics-grid,
  .commercial-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .metric-group + .metric-group {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--color-border-light);
  }

  .metric-group-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
  }

  .metric-group-heading h3 {
    margin: 0;
  }

  .metric-card,
  .commercial-total {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
  }

  .metric-card:hover {
    text-decoration: none;
    border-color: var(--color-primary);
  }

  .metric-card strong,
  .commercial-total strong {
    font-size: 1.65rem;
    color: var(--color-primary);
  }

  .metric-card small,
  .section-note {
    color: var(--color-text-muted);
  }

  .commercial-shell {
    margin-top: 1.5rem;
  }

  .tabs {
    display: flex;
    gap: 0.5rem;
    margin: 1rem 0 0.5rem;
    flex-wrap: wrap;
  }

  .tabs button {
    border: 1px solid var(--color-border);
    background: white;
    padding: 0.45rem 0.8rem;
    border-radius: 999px;
  }

  .tabs button.active {
    background: var(--color-primary);
    color: white;
    border-color: var(--color-primary);
  }

  .data-quality,
  .empty-state {
    margin-top: 1rem;
    padding: 0.85rem 1rem;
    border-radius: var(--radius-md);
  }

  .data-quality {
    background: #fff8e6;
    border: 1px solid #f0cc72;
  }

  .empty-state {
    background: var(--color-bg);
    border: 1px solid var(--color-border-light);
  }

  .table-wrap {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th,
  td {
    padding: 0.65rem;
    text-align: right;
    border-bottom: 1px solid var(--color-border-light);
  }

  th:nth-child(2),
  td:nth-child(2) {
    text-align: left;
  }

  @media (max-width: 640px) {
    .metrics-heading,
    .section-heading {
      flex-direction: column;
    }

    .metrics-grid,
    .commercial-summary {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>

<script>
  import { onMount } from 'svelte';

  const metricGroups = [
    {
      id: 'inquiries',
      label: 'Inquiries',
      description: 'Customer conversations requiring response or follow-up',
      cards: [
        {
          domain: 'inquiries',
          key: 'not_answered',
          label: 'Not answered',
          href: 'https://ops.homesbliss.net/inquiry/',
          mode: 'current_total',
          drilldownLabel: 'Open the Needs reply inquiry queue'
        },
        {
          domain: 'inquiries',
          key: 'closed_won',
          label: 'Closed Won',
          href: null,
          drilldownUnavailable: 'Historical transition drill-through is not available yet'
        },
        {
          domain: 'inquiries',
          key: 'followed_up',
          label: 'Followed-up',
          href: null,
          drilldownUnavailable: 'Historical transition drill-through is not available yet'
        }
      ]
    },
    {
      id: 'tickets',
      label: 'Tickets',
      description: 'Operator tickets across all queues',
      cards: [
        {
          domain: 'tickets',
          key: 'open',
          label: 'Open tickets',
          href: 'https://ops.homesbliss.net/tickets/?status_group=non_terminal',
          mode: 'current_total',
          drilldownLabel: 'Open the non-terminal ticket queue'
        },
        {
          domain: 'tickets',
          key: 'urgent_open',
          label: 'Urgent open tickets',
          href: 'https://ops.homesbliss.net/tickets/?status_group=non_terminal&priority=urgent',
          mode: 'current_total',
          drilldownLabel: 'Open the urgent open ticket queue'
        },
        {
          domain: 'tickets',
          key: 'closed',
          label: 'Closed tickets',
          href: null,
          drilldownUnavailable: 'Historical closure drill-through is not available yet'
        }
      ]
    },
    {
      id: 'orders',
      label: 'Orders',
      description: 'Orders that require operational intervention',
      cards: [
        {
          domain: 'orders',
          key: 'on_hold',
          label: 'Current On Hold orders',
          href: 'https://ops.homesbliss.net/order/?lifecycle=active&review=on_hold',
          mode: 'current_total',
          drilldownLabel: 'Open the active On Hold order queue'
        },
        {
          domain: 'orders',
          key: 'waiting_for_payment',
          label: 'Waiting for Payment',
          href: 'https://ops.homesbliss.net/order/?lifecycle=waiting_for_payment',
          mode: 'current_total',
          drilldownLabel: 'Open the Waiting for Payment order queue'
        }
      ]
    }
  ];

  const tabs = [
    {
      key: 'by_shop_account',
      label: 'Shop accounts',
      description: 'Paid sales by marketplace shop account'
    },
    {
      key: 'top_products',
      label: 'Top products',
      description: 'Top 20 products ranked by units sold'
    },
    {
      key: 'by_supplier',
      label: 'GigaB2B suppliers',
      description: 'Upstream GigaB2B suppliers, never marketplace shops'
    }
  ];

  let windowKey = 'last_30_days';
  let metrics = null;
  let metricsLoading = true;
  let activeBreakdown = 'by_shop_account';

  async function loadMetrics() {
    metricsLoading = true;
    try {
      const response = await fetch(`/_gateway/metrics?window=${windowKey}`);
      metrics = response.ok ? await response.json() : null;
    } catch {
      metrics = null;
    } finally {
      metricsLoading = false;
    }
  }

  function owner(domain) {
    return metrics?.owners?.[domain];
  }

  function metric(card) {
    return owner(card.domain)?.ok ? owner(card.domain).data.metrics?.[card.key] : null;
  }

  function displayCount(card) {
    const value = metric(card);
    const count = card.mode === 'current_total' ? value?.current_count : value?.window_count;
    return Number.isInteger(count) &&
      (card.mode === 'current_total' || value?.status === 'available')
      ? count.toLocaleString()
      : 'Unavailable';
  }

  function cardDetail(card) {
    const value = metric(card);
    if (card.mode === 'current_total') return 'All active records · not time-windowed';
    return Number.isInteger(value?.current_count)
      ? `Current stock: ${value.current_count.toLocaleString()}`
      : '';
  }

  function commercial() {
    return owner('orders')?.ok ? owner('orders').data.commercial : null;
  }

  function breakdownRows() {
    return commercial()?.[activeBreakdown] || [];
  }

  function activeTab() {
    return tabs.find((tab) => tab.key === activeBreakdown);
  }

  function formatJpy(value) {
    return `¥${Number(value || 0).toLocaleString()}`;
  }

  function supplierMappingUnavailable() {
    return commercial()?.warnings?.includes('supplier_mapping_unavailable');
  }

  onMount(loadMetrics);
</script>

<svelte:head>
  <title>Metrics — Ops Portal</title>
</svelte:head>

<h1>Operational metrics</h1>
<p class="text-muted mt-sm mb-lg">Retailpulses operations overview</p>

<section class="metrics-shell" aria-labelledby="metrics-title">
  <div class="metrics-heading">
    <div>
      <h2 id="metrics-title">Current performance</h2>
      <p class="text-muted text-sm">JST · owner-calculated · read only</p>
    </div>
    <select bind:value={windowKey} onchange={loadMetrics} aria-label="Metrics time window">
      <option value="last_7_days">Last 7 days</option>
      <option value="last_30_days">Last 30 days</option>
      <option value="current_month">Current month</option>
    </select>
  </div>

  <div aria-busy={metricsLoading}>
    {#each metricGroups as group (group.id)}
      <section class="metric-group" aria-labelledby={`metrics-${group.id}`}>
        <div class="metric-group-heading">
          <h3 id={`metrics-${group.id}`}>{group.label}</h3>
          <span class="section-note text-sm">{group.description}</span>
        </div>
        <div class="metrics-grid">
          {#each group.cards as card (card.key)}
            {#if card.href}
              <!-- External canonical operator routes intentionally bypass SvelteKit resolve. -->
              <!-- eslint-disable svelte/no-navigation-without-resolve -->
              <a
                class="metric-card"
                href={card.href}
                aria-label={card.drilldownLabel || card.label}
              >
                <span>{card.label}</span>
                <strong>{metricsLoading ? '…' : displayCount(card)}</strong>
                {#if cardDetail(card)}
                  <small>{cardDetail(card)}</small>
                {/if}
              </a>
              <!-- eslint-enable svelte/no-navigation-without-resolve -->
            {:else}
              <div class="metric-card" aria-label={card.label}>
                <span>{card.label}</span>
                <strong>{metricsLoading ? '…' : displayCount(card)}</strong>
                <small>{card.drilldownUnavailable}</small>
              </div>
            {/if}
          {/each}
        </div>
      </section>
    {/each}
  </div>
</section>

<section class="commercial-shell" aria-labelledby="commercial-title">
  <div class="section-heading">
    <div>
      <h2 id="commercial-title">Sales breakdown</h2>
      <p class="text-muted text-sm">
        Paid orders · selected JST window · Gross sales before fees and procurement cost
      </p>
    </div>
    {#if commercial()?.generated_at}
      <span class="section-note text-sm"
        >Updated {new Date(commercial().generated_at).toLocaleString()}</span
      >
    {/if}
  </div>

  {#if metricsLoading}
    <div class="empty-state">Loading commercial metrics…</div>
  {:else if commercial()?.status === 'available'}
    <div class="commercial-summary" aria-label="Commercial totals">
      <div class="commercial-total">
        <span>Gross sales</span><strong>{formatJpy(commercial().totals?.gross_sales_jpy)}</strong>
      </div>
      <div class="commercial-total">
        <span>Units sold</span><strong
          >{Number(commercial().totals?.units_sold || 0).toLocaleString()}</strong
        >
      </div>
      <div class="commercial-total">
        <span>Paid orders</span><strong
          >{Number(commercial().totals?.order_count || 0).toLocaleString()}</strong
        >
      </div>
    </div>

    {#if supplierMappingUnavailable()}
      <div class="data-quality" role="status">
        <strong>Supplier attribution needs mapping.</strong> Shop-account and product rankings are available.
        Supplier rows remain explicitly unmapped until the Supabase business master contains a deterministic
        primary GigaB2B supplier for each product.
      </div>
    {/if}

    <div class="tabs" role="tablist" aria-label="Sales breakdown dimension">
      {#each tabs as tab (tab.key)}
        <button
          class:active={activeBreakdown === tab.key}
          onclick={() => (activeBreakdown = tab.key)}
          role="tab"
          aria-selected={activeBreakdown === tab.key}>{tab.label}</button
        >
      {/each}
    </div>
    <p class="section-note text-sm">{activeTab()?.description}</p>

    {#if breakdownRows().length > 0}
      <div class="table-wrap">
        <table>
          <thead
            ><tr><th>Rank</th><th>Name</th><th>Gross sales</th><th>Units</th><th>Orders</th></tr
            ></thead
          >
          <tbody>
            {#each breakdownRows() as row (row.key)}
              <tr>
                <td>{row.rank}</td>
                <td>{row.label}</td>
                <td>{formatJpy(row.gross_sales_jpy)}</td>
                <td>{Number(row.units_sold || 0).toLocaleString()}</td>
                <td>{Number(row.order_count || 0).toLocaleString()}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="empty-state">No eligible paid order lines in this window.</div>
    {/if}
  {:else}
    <div class="empty-state" role="status">
      Sales breakdown is unavailable from the Orders owner. The operational cards remain independent
      and continue to show their own owner data.
    </div>
  {/if}
</section>
