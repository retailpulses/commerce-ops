/**
 * Cloudflare Pages Function — /api/ask
 *
 * Natural Language Q&A over the Ops Portal catalog.
 * Retrieval-first: pre-matches catalog entities, then calls OpenAI gpt-4o
 * with allowlisted tools for reading repo docs and skill files via GitHub API.
 */

// ─── Embedded Catalog Data ───────────────────────────────────────────────

/** @type {Array<{id:string,name:string,description:string,primaryLanguage:string,visibility:string,url:string,capabilityDomains:string[]}>} */
const REPOS = [
  {
    id: 'OrderMgmt',
    name: 'OrderMgmt',
    description: 'Order management',
    primaryLanguage: 'JavaScript',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/OrderMgmt',
    capabilityDomains: ['catalog']
  },
  {
    id: 'ticket-handling',
    name: 'ticket-handling',
    description: 'Mercari Shop ticket management automation script',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/ticket-handling',
    capabilityDomains: ['communication']
  },
  {
    id: 'boutique-listing',
    name: 'boutique-listing',
    description: 'Boutique Listing Web-Based Tool — Mercari MVP',
    primaryLanguage: 'JavaScript',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/boutique-listing',
    capabilityDomains: ['marketplace:mercari']
  },
  {
    id: 'backoffice',
    name: 'backoffice',
    description: 'Backoffice admin tasks, compliance calendar, and operational workflows',
    primaryLanguage: '',
    visibility: 'PUBLIC',
    url: 'https://github.com/retailpulses/backoffice',
    capabilityDomains: ['ops']
  },
  {
    id: '.github',
    name: '.github',
    description: 'Retailpulses central engineering governance',
    primaryLanguage: '',
    visibility: 'PUBLIC',
    url: 'https://github.com/retailpulses/.github',
    capabilityDomains: ['ops']
  },
  {
    id: 'inquiry-automation',
    name: 'inquiry-automation',
    description: 'Build the MVP runtime for Retailpulses inquiry automation',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/inquiry-automation',
    capabilityDomains: ['inquiry']
  },
  {
    id: 'CatalogSync',
    name: 'CatalogSync',
    description: 'Catalog sync',
    primaryLanguage: 'JavaScript',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/CatalogSync',
    capabilityDomains: ['catalog']
  },
  {
    id: 'rakutenops',
    name: 'rakutenops',
    description: 'Rakuten listing, activation, pricing, CSV gen, image prep',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/rakutenops',
    capabilityDomains: ['marketplace:rakuten']
  },
  {
    id: 'workers',
    name: 'workers',
    description: 'Cloudflare Workers monorepo for cross-platform services',
    primaryLanguage: 'JavaScript',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/workers',
    capabilityDomains: ['ops']
  },
  {
    id: 'mercariops',
    name: 'mercariops',
    description: 'Mercari listing, timesale, tickets, CSV, copywriting, reporting',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/mercariops',
    capabilityDomains: ['marketplace:mercari']
  },
  {
    id: 'inbox',
    name: 'inbox',
    description: 'Inbox handling',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/inbox',
    capabilityDomains: ['communication']
  },
  {
    id: 'Archon',
    name: 'Archon',
    description: 'The first open-source harness builder for AI coding',
    primaryLanguage: 'TypeScript',
    visibility: 'PUBLIC',
    url: 'https://github.com/retailpulses/Archon',
    capabilityDomains: ['ops']
  },
  {
    id: 'amazonops',
    name: 'amazonops',
    description: 'Amazon listing sync, price mgmt, inventory flatfile, strategy',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/amazonops',
    capabilityDomains: ['marketplace:amazon']
  },
  {
    id: 'retailpulses-tool-services',
    name: 'retailpulses-tool-services',
    description: 'Tool services for Retailpulses agent workflows',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/retailpulses-tool-services',
    capabilityDomains: ['ops']
  },
  {
    id: 'homepage',
    name: 'homepage',
    description: 'Homepage',
    primaryLanguage: 'Python',
    visibility: 'PRIVATE',
    url: 'https://github.com/retailpulses/homepage',
    capabilityDomains: ['ops']
  }
];

/** @type {Array<{id:string,name:string,description:string,level:string,installed:boolean,capabilityDomains:string[],sourcePath:string,workspacePaths:string[]}>} */
const SKILLS = [
  {
    id: '1688-sourcing',
    name: '1688-sourcing',
    description: '1688 image-based product matching',
    level: 'account',
    installed: false,
    capabilityDomains: ['sourcing'],
    sourcePath: 'retailpulses-agent-skills/skills/account/1688-sourcing/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/1688-sourcing/SKILL.md'
    ]
  },
  {
    id: 'ab-test-setup',
    name: 'ab-test-setup',
    description: 'Plan, design, or implement an A/B test or experiment',
    level: 'account',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/account/ab-test-setup/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/ab-test-setup/SKILL.md'
    ]
  },
  {
    id: 'accio-mcp-cli',
    name: 'accio-mcp-cli',
    description: 'Discover, search, and invoke MCP tools via the Accio Work gateway',
    level: 'agent',
    installed: false,
    capabilityDomains: ['communication'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/accio-mcp-cli/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/accio-mcp-cli/SKILL.md'
    ]
  },
  {
    id: 'amazon-inventory-flatfile',
    name: 'amazon-inventory-flatfile',
    description: 'Update Amazon listing inventory in Baserow, generate flat files',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:amazon'],
    sourcePath: '/Users/user/.codex/skills/amazon-inventory-flatfile/SKILL.md',
    workspacePaths: [
      'retailpulses-agent-skills/skills/account/amazon-inventory-flatfile/SKILL.md',
      'agent-core/repos/retailpulses-agent-skills/skills/account/amazon-inventory-flatfile/SKILL.md'
    ]
  },
  {
    id: 'amazon-listing-expert',
    name: 'amazon-listing-expert',
    description: 'Creates and optimizes Amazon product listings',
    level: 'account',
    installed: false,
    capabilityDomains: ['marketplace:amazon'],
    sourcePath: 'retailpulses-agent-skills/skills/account/amazon-listing-expert/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/amazon-listing-expert/SKILL.md'
    ]
  },
  {
    id: 'amz-product-optimizer',
    name: 'amz-product-optimizer',
    description: 'Amazon product optimization end-to-end automation',
    level: 'account',
    installed: false,
    capabilityDomains: ['marketplace:amazon'],
    sourcePath: 'retailpulses-agent-skills/skills/account/amz-product-optimizer/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/amz-product-optimizer/SKILL.md'
    ]
  },
  {
    id: 'baserow-database-manager',
    name: 'baserow-database-manager',
    description: 'Standalone Baserow API skill for CRUD, table management, data queries',
    level: 'account',
    installed: true,
    capabilityDomains: ['data:baserow'],
    sourcePath: '/Users/user/.codex/skills/baserow-database-manager/SKILL.md',
    workspacePaths: [
      'retailpulses-agent-skills/skills/account/baserow-database-manager/SKILL.md',
      'retailpulses-agent-skills/skills/agent/baserow-database-manager/SKILL.md'
    ]
  },
  {
    id: 'baserow-schema-editor',
    name: 'baserow-schema-editor',
    description: 'Edit Baserow schema by adding, renaming, or deleting fields',
    level: 'account',
    installed: true,
    capabilityDomains: ['data:baserow'],
    sourcePath: '/Users/user/.codex/skills/baserow-schema-editor/SKILL.md',
    workspacePaths: [
      'retailpulses-agent-skills/skills/account/baserow-schema-editor/SKILL.md',
      'retailpulses-agent-skills/skills/agent/baserow-schema-editor/SKILL.md'
    ]
  },
  {
    id: 'copywriting',
    name: 'copywriting',
    description: 'Write, rewrite, or improve marketing copy',
    level: 'account',
    installed: false,
    capabilityDomains: ['content'],
    sourcePath: 'retailpulses-agent-skills/skills/account/copywriting/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/copywriting/SKILL.md'
    ]
  },
  {
    id: 'cross-border-selection',
    name: 'cross-border-selection',
    description: 'Cross-border e-commerce product selection workflow',
    level: 'account',
    installed: false,
    capabilityDomains: ['sourcing'],
    sourcePath: 'retailpulses-agent-skills/skills/account/cross-border-selection/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/cross-border-selection/SKILL.md'
    ]
  },
  {
    id: 'docx',
    name: 'docx',
    description: 'Document creation, editing, and analysis',
    level: 'agent',
    installed: false,
    capabilityDomains: ['office'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/docx/SKILL.md',
    workspacePaths: ['agent-core/repos/retailpulses-agent-skills/skills/agent/docx/SKILL.md']
  },
  {
    id: 'find-skills',
    name: 'find-skills',
    description: 'Helps users discover and install agent skills',
    level: 'account',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/account/find-skills/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/find-skills/SKILL.md'
    ]
  },
  {
    id: 'giga-resource-pack-copywriting',
    name: 'giga-resource-pack-copywriting',
    description: 'Generate Japanese marketplace copy from Giga Item Code',
    level: 'account',
    installed: true,
    capabilityDomains: ['content'],
    sourcePath: '/Users/user/.codex/skills/giga-resource-pack-copywriting/SKILL.md',
    workspacePaths: [
      'retailpulses-agent-skills/skills/account/giga-resource-pack-copywriting/SKILL.md'
    ]
  },
  {
    id: 'gigab2b-api-access',
    name: 'gigab2b-api-access',
    description: 'Signed OpenAPI skill for GigaB2B product, price, and shipping queries',
    level: 'account',
    installed: true,
    capabilityDomains: ['sourcing'],
    sourcePath: '/Users/user/.codex/skills/gigab2b-api-access/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/gigab2b-api-access/SKILL.md']
  },
  {
    id: 'gigab2b-workflow',
    name: 'gigab2b-workflow',
    description: 'Combined GigaB2B API query and sync to Baserow',
    level: 'account',
    installed: false,
    capabilityDomains: ['sourcing'],
    sourcePath: 'retailpulses-agent-skills/skills/account/gigab2b-workflow/SKILL.md',
    workspacePaths: []
  },
  {
    id: 'gmail-assistant',
    name: 'gmail-assistant',
    description: 'Send, search, and manage Gmail messages',
    level: 'agent',
    installed: false,
    capabilityDomains: ['communication'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/gmail-assistant/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/gmail-assistant/SKILL.md'
    ]
  },
  {
    id: 'higgsfield-guide',
    name: 'higgsfield-guide',
    description: 'Generate images and videos using Higgsfield AI',
    level: 'account',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/account/higgsfield-guide/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/higgsfield-guide/SKILL.md'
    ]
  },
  {
    id: 'invoice-receipt-automation',
    name: 'invoice-receipt-automation',
    description: 'Review and execute invoice, receipt, and batch workflows',
    level: 'account',
    installed: true,
    capabilityDomains: ['ops'],
    sourcePath: '/Users/user/.codex/skills/invoice-receipt-automation/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/invoice-receipt-automation/SKILL.md']
  },
  {
    id: 'jp-payroll-assistant',
    name: 'jp-payroll-assistant',
    description: 'Prepare monthly Japanese payroll slips in Baserow',
    level: 'agent',
    installed: false,
    capabilityDomains: ['jp'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/jp-payroll-assistant/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/jp-payroll-assistant/SKILL.md'
    ]
  },
  {
    id: 'mercari-category-id',
    name: 'mercari-category-id',
    description: 'Populate Mercari category IDs in Baserow Products',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:mercari'],
    sourcePath: '/Users/user/.codex/skills/mercari-category-id/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/mercari-category-id/SKILL.md']
  },
  {
    id: 'mercari-csv-listing',
    name: 'mercari-csv-listing',
    description: 'Build a Mercari listing CSV from Item Codes or GigaB2B Excel',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:mercari'],
    sourcePath: '/Users/user/.codex/skills/mercari-csv-listing/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/mercari-csv-listing/SKILL.md']
  },
  {
    id: 'mercari-settlement-pdf',
    name: 'mercari-settlement-pdf',
    description: 'Generate a Mercari settlement PDF',
    level: 'agent',
    installed: false,
    capabilityDomains: ['marketplace:mercari'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/mercari-settlement-pdf/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/mercari-settlement-pdf/SKILL.md'
    ]
  },
  {
    id: 'mercari-shop-api-specialist',
    name: 'mercari-shop-api-specialist',
    description: 'Handle Mercari Shop API work from Conoha VPS',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:mercari'],
    sourcePath: '/Users/user/.codex/skills/mercari-shop-api-specialist/SKILL.md',
    workspacePaths: [
      'retailpulses-agent-skills/skills/account/mercari-shop-api-specialist/SKILL.md'
    ]
  },
  {
    id: 'mercari-ticket-mgmt-hourly',
    name: 'mercari-ticket-mgmt-hourly',
    description: 'Process Mercari Shop unread transaction messages',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:mercari'],
    sourcePath: '/Users/user/.codex/skills/mercari-ticket-mgmt-hourly/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/mercari-ticket-mgmt-hourly/SKILL.md']
  },
  {
    id: 'mercari-timesale-csv',
    name: 'mercari-timesale-csv',
    description: 'Build Mercari Shops timesale CSV files',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:mercari'],
    sourcePath: '/Users/user/.codex/skills/mercari-timesale-csv/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/mercari-timesale-csv/SKILL.md']
  },
  {
    id: 'pdf',
    name: 'pdf',
    description: 'PDF manipulation toolkit',
    level: 'agent',
    installed: false,
    capabilityDomains: ['office'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/pdf/SKILL.md',
    workspacePaths: ['agent-core/repos/retailpulses-agent-skills/skills/agent/pdf/SKILL.md']
  },
  {
    id: 'pptx',
    name: 'pptx',
    description: 'Presentation creation, editing, and analysis',
    level: 'agent',
    installed: false,
    capabilityDomains: ['office'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/pptx/SKILL.md',
    workspacePaths: ['agent-core/repos/retailpulses-agent-skills/skills/agent/pptx/SKILL.md']
  },
  {
    id: 'rakuten-resource-pack-images',
    name: 'rakuten-resource-pack-images',
    description: 'Generate Rakuten main-image fail-fast batch',
    level: 'account',
    installed: true,
    capabilityDomains: ['marketplace:rakuten'],
    sourcePath: '/Users/user/.codex/skills/rakuten-resource-pack-images/SKILL.md',
    workspacePaths: []
  },
  {
    id: 'seo-keyword-research',
    name: 'seo-keyword-research',
    description: 'Discover high-value keywords and classify search intent',
    level: 'account',
    installed: false,
    capabilityDomains: ['content'],
    sourcePath: 'retailpulses-agent-skills/skills/account/seo-keyword-research/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/seo-keyword-research/SKILL.md'
    ]
  },
  {
    id: 'self-improvement',
    name: 'self-improvement',
    description: 'Captures learnings and errors into daily diary',
    level: 'agent',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/self-improvement/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/self-improvement/SKILL.md'
    ]
  },
  {
    id: 'skill-creator',
    name: 'skill-creator',
    description: 'Create, modify, and improve skills',
    level: 'agent',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/skill-creator/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/skill-creator/SKILL.md'
    ]
  },
  {
    id: 'skill-finder',
    name: 'skill-finder',
    description: 'Find, search, recommend, and install agent skills',
    level: 'agent',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/skill-finder/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/skill-finder/SKILL.md'
    ]
  },
  {
    id: 'skill-writer',
    name: 'skill-writer',
    description: 'Guide users through creating Agent Skills',
    level: 'account',
    installed: false,
    capabilityDomains: ['agent:misc'],
    sourcePath: 'retailpulses-agent-skills/skills/account/skill-writer/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/account/skill-writer/SKILL.md'
    ]
  },
  {
    id: 'sync-giga-saved-products',
    name: 'sync-giga-saved-products',
    description: 'Sync GigaB2B saved products into Baserow',
    level: 'account',
    installed: true,
    capabilityDomains: ['sourcing'],
    sourcePath: '/Users/user/.codex/skills/sync-giga-saved-products/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/account/sync-giga-saved-products/SKILL.md']
  },
  {
    id: 'xlsx',
    name: 'xlsx',
    description: 'Spreadsheet creation, editing, and analysis',
    level: 'agent',
    installed: false,
    capabilityDomains: ['office'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/xlsx/SKILL.md',
    workspacePaths: ['agent-core/repos/retailpulses-agent-skills/skills/agent/xlsx/SKILL.md']
  },
  {
    id: 'zoho-mail-access',
    name: 'zoho-mail-access',
    description: 'Standalone Zoho Mail access for searches',
    level: 'agent',
    installed: false,
    capabilityDomains: ['communication'],
    sourcePath: 'retailpulses-agent-skills/skills/agent/zoho-mail-access/SKILL.md',
    workspacePaths: [
      'agent-core/repos/retailpulses-agent-skills/skills/agent/zoho-mail-access/SKILL.md'
    ]
  },
  {
    id: 'zoho-mail-handler',
    name: 'zoho-mail-handler',
    description: 'Zoho Mail REST API: search, fetch, draft, send',
    level: 'account',
    installed: true,
    capabilityDomains: ['communication'],
    sourcePath: '/Users/user/.codex/skills/zoho-mail-handler/SKILL.md',
    workspacePaths: ['retailpulses-agent-skills/skills/agent/zoho-mail-handler/SKILL.md']
  }
];

/** @type {Array<{id:string,label:string,description:string,iconHint:string,repoIds:string[],skillIds:string[]}>} */
const DOMAINS = [
  {
    id: 'marketplace:mercari',
    label: 'Mercari Marketplace Operations',
    description: 'Listing, CSV, API, tickets, timesales, category management on Mercari Shops',
    iconHint: 'shopping-bag',
    repoIds: ['mercariops', 'boutique-listing'],
    skillIds: [
      'mercari-csv-listing',
      'mercari-shop-api-specialist',
      'mercari-ticket-mgmt-hourly',
      'mercari-timesale-csv',
      'mercari-category-id',
      'mercari-settlement-pdf'
    ]
  },
  {
    id: 'marketplace:rakuten',
    label: 'Rakuten Marketplace Operations',
    description: 'Rakuten listing, activation, pricing, CSV generation, image preparation',
    iconHint: 'globe',
    repoIds: ['rakutenops'],
    skillIds: ['rakuten-resource-pack-images']
  },
  {
    id: 'marketplace:amazon',
    label: 'Amazon Marketplace Operations',
    description:
      'Amazon listing sync, pricing, inventory flatfiles, listing optimization, product optimization',
    iconHint: 'shopping-cart',
    repoIds: ['amazonops'],
    skillIds: ['amazon-inventory-flatfile', 'amazon-listing-expert', 'amz-product-optimizer']
  },
  {
    id: 'sourcing',
    label: 'Product Sourcing & GigaB2B',
    description:
      '1688 image matching, GigaB2B API access, product sync, cross-border selection research',
    iconHint: 'search',
    repoIds: [],
    skillIds: [
      '1688-sourcing',
      'gigab2b-api-access',
      'gigab2b-workflow',
      'sync-giga-saved-products',
      'cross-border-selection'
    ]
  },
  {
    id: 'data:baserow',
    label: 'Baserow Data Operations',
    description: 'CRUD, schema management, table creation, field editing for Baserow databases',
    iconHint: 'database',
    repoIds: [],
    skillIds: ['baserow-database-manager', 'baserow-schema-editor']
  },
  {
    id: 'content',
    label: 'Content & Copywriting',
    description:
      'Marketing copy, resource pack copy generation for multiple platforms, SEO keyword research',
    iconHint: 'edit',
    repoIds: [],
    skillIds: ['giga-resource-pack-copywriting', 'copywriting', 'seo-keyword-research']
  },
  {
    id: 'agent:misc',
    label: 'Agent Tooling & Meta-Capabilities',
    description:
      'Skill creation, skill discovery, self-improvement, A/B testing, image/video generation, skill writing',
    iconHint: 'code',
    repoIds: [],
    skillIds: [
      'skill-creator',
      'skill-finder',
      'skill-writer',
      'self-improvement',
      'find-skills',
      'ab-test-setup',
      'higgsfield-guide'
    ]
  },
  {
    id: 'office',
    label: 'Office Document Processing',
    description: 'Word documents, PDFs, presentations, spreadsheets',
    iconHint: 'file-text',
    repoIds: [],
    skillIds: ['docx', 'pdf', 'pptx', 'xlsx']
  },
  {
    id: 'communication',
    label: 'Communication Channels',
    description: 'Zoho Mail, Gmail, Accio MCP CLI, ticket handling, inbox management',
    iconHint: 'message-circle',
    repoIds: ['ticket-handling', 'inbox'],
    skillIds: ['zoho-mail-handler', 'zoho-mail-access', 'gmail-assistant', 'accio-mcp-cli']
  },
  {
    id: 'ops',
    label: 'Operations & Infrastructure',
    description:
      'Backoffice, Cloudflare Workers, governance, tool services, Archon, homepage, invoice automation',
    iconHint: 'settings',
    repoIds: [
      'backoffice',
      '.github',
      'workers',
      'retailpulses-tool-services',
      'Archon',
      'homepage'
    ],
    skillIds: ['invoice-receipt-automation']
  },
  {
    id: 'catalog',
    label: 'Catalog Management',
    description: 'Product catalog sync and order management',
    iconHint: 'package',
    repoIds: ['CatalogSync', 'OrderMgmt'],
    skillIds: []
  },
  {
    id: 'inquiry',
    label: 'Inquiry Automation',
    description: 'Customer inquiry automation runtime',
    iconHint: 'help-circle',
    repoIds: ['inquiry-automation'],
    skillIds: []
  },
  {
    id: 'jp',
    label: 'Japan Operations',
    description: 'Japanese payroll preparation and compliance',
    iconHint: 'flag',
    repoIds: [],
    skillIds: ['jp-payroll-assistant']
  }
];

const URLS = [
  {
    id: 'ops-portal-pages-production',
    label: 'Ops Portal',
    url: 'https://ops-portal-39f.pages.dev',
    category: 'Portal',
    environment: 'production',
    status: 'active',
    notes: 'Current Cloudflare Pages production URL for the internal portal.'
  },
  {
    id: 'ops-portal-custom-domain',
    label: 'Ops Portal (Custom Domain)',
    url: 'https://opsportal.ai',
    category: 'Portal',
    environment: 'preview',
    status: 'pending',
    notes: 'Custom domain attached in Cloudflare Pages and waiting on final validation.'
  }
];

// Build lookup maps
const reposById = new Map(REPOS.map((r) => [r.id, r]));
const skillsById = new Map(SKILLS.map((s) => [s.id, s]));
const domainsById = new Map(DOMAINS.map((d) => [d.id, d]));

const PORTAL_SUMMARY = `The Ops Portal is the internal Retailpulses tool catalog. It contains:
- ${REPOS.length} repos (${REPOS.filter((r) => r.visibility === 'PUBLIC').length} public, ${REPOS.filter((r) => r.visibility === 'PRIVATE').length} private)
- ${SKILLS.length} skills (${SKILLS.filter((s) => s.installed).length} installed, ${SKILLS.filter((s) => !s.installed).length} workspace only)
- ${DOMAINS.length} capability domains
- ${URLS.length} URLs

Languages: ${[...new Set(REPOS.map((r) => r.primaryLanguage).filter(Boolean))].sort().join(', ')}
Domains: ${DOMAINS.map((d) => d.label).join(' | ')}`;

// ─── Retrieval Engine ────────────────────────────────────────────────────

/**
 * Score and rank catalog entities by keyword match against a question.
 * @param {string} question
 * @returns {{ repos: Array<{id:string,score:number}>, skills: Array<{id:string,score:number}>, domains: Array<{id:string,score:number}> }}
 */
function retrieveEntities(question) {
  const q = question.toLowerCase();
  const tokens = q.split(/[\s,?.!]+/).filter((t) => t.length > 1);

  // Detect broad "listing" questions — these need all entities, not just keyword matches
  const listingPatterns = [
    /\b(what|which|list|show|tell|give|name|enumerate|display)\b.*\b(repos?|repositories|skills?|domains?)\b/,
    /\b(repos?|repositories|skills?|domains?)\b.*\b(what|which|list|show|have|exist|available)\b/,
    /\bhow many\b/,
    /\b(all|every)\b.*\b(repos?|repositories|skills?|domains?)\b/,
    /\boverview\b/i,
    /\bsummary\b/i
  ];
  const isListingQuestion = listingPatterns.some((p) => p.test(q));

  // Detect property filters
  const wantsInstalled = /\binstalled\b/.test(q);
  const wantsWorkspace = /\bworkspace\b/.test(q);
  const wantsPrivate = /\bprivate\b/.test(q);
  const wantsPublic = /\bpublic\b/.test(q);
  const wantsPython = /\bpython\b/.test(q);
  const wantsJS = /\b(javascript|typescript|js|ts)\b/.test(q);

  // For listing questions, build filtered entity lists
  /** @type {string[]} */
  let listingRepoIds = null;
  /** @type {string[]} */
  let listingSkillIds = null;
  /** @type {string[]} */
  let listingDomainIds = null;

  if (isListingQuestion) {
    const repoFilter = (r) => {
      if (wantsPrivate && r.visibility !== 'PRIVATE') return false;
      if (wantsPublic && r.visibility !== 'PUBLIC') return false;
      if (wantsPython && r.primaryLanguage !== 'Python') return false;
      if (wantsJS && !['JavaScript', 'TypeScript'].includes(r.primaryLanguage)) return false;
      return true;
    };
    const skillFilter = (s) => {
      if (wantsInstalled && !s.installed) return false;
      if (wantsWorkspace && s.installed) return false;
      return true;
    };

    if (/\b(repos?|repositories)\b/.test(q) || (/\bwhat\b/i.test(q) && !/\bskills?\b/.test(q))) {
      listingRepoIds = REPOS.filter(repoFilter).map((r) => r.id);
    }
    if (/\bskills?\b/.test(q) || (/\bwhat\b/i.test(q) && !/\brepos?\b/.test(q))) {
      listingSkillIds = SKILLS.filter(skillFilter).map((s) => s.id);
    }
    if (/\bdomains?\b/.test(q)) {
      listingDomainIds = DOMAINS.map((d) => d.id);
    }
    // If "what" + no specific noun, include all
    if (/\bwhat\b/.test(q) && !/\b(repos?|repositories|skills?|domains?)\b/.test(q)) {
      listingRepoIds = REPOS.filter(repoFilter).map((r) => r.id);
      listingSkillIds = SKILLS.filter(skillFilter).map((s) => s.id);
      listingDomainIds = DOMAINS.map((d) => d.id);
    }
  }

  /** @param {string} text */
  const score = (text) => {
    const t = text.toLowerCase();
    let s = 0;
    // Exact phrase match
    if (t.includes(q) || q.includes(t)) s += 5;
    // Token matches
    for (const tok of tokens) {
      if (t.includes(tok)) s += 2;
    }
    // Word boundary matches
    for (const tok of tokens) {
      if (new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) s += 1;
    }
    return s;
  };

  let scoredRepos;
  let scoredSkills;
  let scoredDomains;

  if (listingRepoIds) {
    // For listing questions, include all matching repos with a base score
    scoredRepos = listingRepoIds
      .map((id) => {
        const r = reposById.get(id);
        return {
          id,
          score:
            (r
              ? score(
                  r.name +
                    ' ' +
                    r.description +
                    ' ' +
                    r.primaryLanguage +
                    ' ' +
                    r.capabilityDomains.join(' ')
                )
              : 0) + 1
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, REPOS.length);
  } else {
    scoredRepos = REPOS.map((r) => ({
      id: r.id,
      score: score(
        r.name + ' ' + r.description + ' ' + r.primaryLanguage + ' ' + r.capabilityDomains.join(' ')
      )
    }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  if (listingSkillIds) {
    scoredSkills = listingSkillIds
      .map((id) => {
        const s = skillsById.get(id);
        return {
          id,
          score:
            (s ? score(s.name + ' ' + s.description + ' ' + s.capabilityDomains.join(' ')) : 0) + 1
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, listingSkillIds.length);
  } else {
    scoredSkills = SKILLS.map((s) => ({
      id: s.id,
      score: score(s.name + ' ' + s.description + ' ' + s.capabilityDomains.join(' '))
    }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
  }

  if (listingDomainIds) {
    scoredDomains = listingDomainIds
      .map((id) => {
        const d = domainsById.get(id);
        return { id, score: (d ? score(d.label + ' ' + d.description) : 0) + 1 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, listingDomainIds.length);
  } else {
    scoredDomains = DOMAINS.map((d) => ({ id: d.id, score: score(d.label + ' ' + d.description) }))
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // If nothing matched, include a broad set for context
  if (scoredRepos.length === 0 && scoredSkills.length === 0 && scoredDomains.length === 0) {
    // Try domain keywords
    const domainKeywords = {
      mercari: 'marketplace:mercari',
      rakuten: 'marketplace:rakuten',
      amazon: 'marketplace:amazon',
      baserow: 'data:baserow',
      sourcing: 'sourcing',
      communication: 'communication',
      catalog: 'catalog',
      inquiry: 'inquiry',
      japan: 'jp',
      payroll: 'jp',
      office: 'office',
      content: 'content',
      copywriting: 'content',
      seo: 'content',
      ops: 'ops',
      operations: 'ops',
      infrastructure: 'ops'
    };
    for (const [kw, did] of Object.entries(domainKeywords)) {
      if (q.includes(kw)) {
        const d = domainsById.get(did);
        if (d) scoredDomains.push({ id: did, score: 3 });
      }
    }
  }

  return { repos: scoredRepos, skills: scoredSkills, domains: scoredDomains };
}

/**
 * Build a system prompt with portal summary + matched entity details.
 */
function buildSystemPrompt(matched) {
  const parts = [PORTAL_SUMMARY, '', '─── Relevant Portal Entities ───', ''];

  if (matched.domains.length > 0) {
    parts.push('**Matching Domains:**');
    for (const { id } of matched.domains) {
      const d = domainsById.get(id);
      if (d)
        parts.push(
          `- ${d.label} (${d.id}): ${d.description}. Repos: ${d.repoIds.join(', ') || 'none'}. Skills: ${d.skillIds.join(', ') || 'none'}.`
        );
    }
    parts.push('');
  }

  if (matched.repos.length > 0) {
    parts.push('**Matching Repos:**');
    for (const { id } of matched.repos) {
      const r = reposById.get(id);
      if (r)
        parts.push(
          `- ${r.name} (${r.id}): ${r.description} [${r.primaryLanguage || 'no primary language'}, ${r.visibility}] — ${r.url}`
        );
    }
    parts.push('');
  }

  if (matched.skills.length > 0) {
    parts.push('**Matching Skills:**');
    for (const { id } of matched.skills) {
      const s = skillsById.get(id);
      if (s)
        parts.push(
          `- ${s.name} (${s.id}, ${s.level}): ${s.description} [${s.installed ? 'installed' : 'workspace only'}]`
        );
    }
    parts.push('');
  }

  parts.push(`─── Instructions ───
You are the Ops Portal assistant. Answer questions about the portal catalog using the data above.
- Be concise and factual. Cite specific entity names and IDs.
- For listing/counting/filtering questions (e.g., "what repos?", "which are installed?", "how many Python?", "list all private"), answer DIRECTLY from the catalog data above without calling tools. The matching entities shown are already filtered to what the user asked about.
- Only use read_repo_doc or read_skill_file when the user asks for DETAILS about a SPECIFIC repo or skill that go beyond the catalog summary.
- If the answer is not in the catalog data or retrieved documents, say so honestly.
- Do not make up information. Always cite your sources.`);

  return parts.join('\n');
}

// ─── File Guards ─────────────────────────────────────────────────────────

/** Allowlisted doc keys and their resolved file paths */
const ALLOWLISTED_DOCS = {
  README: 'README.md',
  AGENTS: 'AGENTS.md',
  CLAUDE: 'CLAUDE.md',
  'package.json': 'package.json',
  CONTRIBUTING: 'CONTRIBUTING.md',
  CHANGELOG: 'CHANGELOG.md'
};

/** Patterns that are always rejected */
const BLOCKED_PATTERNS = [
  /\.env/i,
  /\.secret/i,
  /credentials/i,
  /secret/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa/i,
  /\.lock$/i,
  /package-lock/i,
  /yarn\.lock/i,
  /pnpm-lock/i,
  /\.min\./i,
  /\.bundle\./i,
  /node_modules/i,
  /\.git\//i
];

/** Max file size in bytes */
const MAX_FILE_SIZE = 50_000;
/** Max decoded content length */
const MAX_CONTENT_LENGTH = 6000;

/**
 * Check if a path is safe to fetch.
 * @param {string} path
 * @returns {{ safe: boolean, reason?: string }}
 */
function guardFilePath(path) {
  if (!path || typeof path !== 'string') return { safe: false, reason: 'invalid path' };
  if (path.includes('..')) return { safe: false, reason: 'path traversal blocked' };
  if (path.startsWith('/')) return { safe: false, reason: 'absolute path blocked' };
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(path)) return { safe: false, reason: `blocked pattern: ${pattern}` };
  }
  // Reject binary extensions
  if (
    /\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|zip|tar|gz|mp[34]|webm|mov|avi|exe|dll|so|dylib|wasm)$/i.test(
      path
    )
  ) {
    return { safe: false, reason: 'binary file blocked' };
  }
  return { safe: true };
}

// ─── Tool Implementations ────────────────────────────────────────────────

/**
 * Resolve a docKey to a file path.
 * @param {string} docKey
 * @returns {{ path: string } | { error: string }}
 */
function resolveDocKey(docKey) {
  // Direct allowlist match
  if (ALLOWLISTED_DOCS[docKey]) return { path: ALLOWLISTED_DOCS[docKey] };
  // docs/* pattern
  if (docKey.startsWith('docs/') && docKey.length > 5) {
    const subpath = docKey.slice(5);
    if (!subpath || subpath.includes('..')) return { error: `invalid docs path: ${docKey}` };
    return { path: `docs/${subpath}` };
  }
  return {
    error: `docKey "${docKey}" not allowlisted. Valid keys: ${Object.keys(ALLOWLISTED_DOCS).join(', ')}, docs/*`
  };
}

/**
 * Fetch a file from a retailpulses repo via GitHub API.
 */
async function fetchFromGitHub(repoId, filePath, githubToken) {
  const url = `https://api.github.com/repos/retailpulses/${encodeURIComponent(repoId)}/contents/${encodeURIComponent(filePath)}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ops-portal-ask/1.0'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      if (res.status === 404) return { error: `file not found: ${repoId}/${filePath}` };
      if (res.status === 403)
        return { error: `GitHub API rate limited or access denied for ${repoId}` };
      return { error: `GitHub API error ${res.status} for ${repoId}/${filePath}` };
    }

    const data = await res.json();
    if (!data.content || data.encoding !== 'base64') {
      return { error: `unexpected GitHub response format for ${repoId}/${filePath}` };
    }
    if (data.size > MAX_FILE_SIZE) {
      return {
        error: `file too large (${data.size} bytes, max ${MAX_FILE_SIZE}) for ${repoId}/${filePath}`
      };
    }

    const decoded = atob(data.content.replace(/\n/g, ''));
    return {
      content: decoded.slice(0, MAX_CONTENT_LENGTH),
      truncated: decoded.length > MAX_CONTENT_LENGTH,
      size: data.size,
      path: data.path
    };
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return { error: `GitHub API timed out for ${repoId}/${filePath}` };
    }
    return { error: `GitHub API error: ${err.message} for ${repoId}/${filePath}` };
  }
}

/**
 * Resolve the GitHub path for a skill's SKILL.md.
 */
function resolveSkillPath(skill) {
  // If sourcePath starts with retailpulses-agent-skills/, use directly
  if (skill.sourcePath.startsWith('retailpulses-agent-skills/')) {
    return skill.sourcePath;
  }
  // Try workspacePaths for a retailpulses-agent-skills path
  for (const wp of skill.workspacePaths || []) {
    if (wp.startsWith('retailpulses-agent-skills/')) {
      return wp;
    }
  }
  // Fallback: construct from level
  return `retailpulses-agent-skills/skills/${skill.level}/${skill.id}/SKILL.md`;
}

// ─── OpenAI API ──────────────────────────────────────────────────────────

const OPENAI_BASE = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o';
const FETCH_TIMEOUT_MS = 25_000; // Timeout for external API calls

/**
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {Array<{role:string,content:string}>} opts.messages
 * @param {string} opts.apiKey
 * @param {boolean} opts.stream
 * @returns {Promise<Response>}
 */
async function callOpenAI({ systemPrompt, messages, apiKey, stream }) {
  const body = {
    model: MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    stream,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_repo_doc',
          description:
            'Read an allowlisted document from a Retailpulses repository. Use to get more details about a repo.',
          parameters: {
            type: 'object',
            properties: {
              repoId: {
                type: 'string',
                description: "The repository ID (e.g., 'OrderMgmt', 'mercariops')"
              },
              docKey: {
                type: 'string',
                description:
                  'The document key: README, AGENTS, CLAUDE, package.json, CONTRIBUTING, CHANGELOG, or docs/*'
              }
            },
            required: ['repoId', 'docKey'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'read_skill_file',
          description:
            'Read the SKILL.md definition for a skill. Use ONLY when the catalog data is insufficient. Prefer answering from the catalog data provided in the system prompt.',
          parameters: {
            type: 'object',
            properties: {
              skillId: {
                type: 'string',
                description:
                  "The skill ID (e.g., 'mercari-csv-listing', 'baserow-database-manager')"
              }
            },
            required: ['skillId'],
            additionalProperties: false
          }
        }
      }
    ],
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 2000
  };

  return fetch(OPENAI_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

// ─── SSE Helpers ─────────────────────────────────────────────────────────

/** @param {ReadableStreamDefaultController} controller @param {string} event @param {object} data */
function sendSSE(controller, event, data) {
  const encoder = new TextEncoder();
  controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

// ─── Rate Limiting ───────────────────────────────────────────────────────

/** Simple in-memory rate limiter (per function instance) */
const rateMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 20;

/**
 * @param {string} ip
 * @returns {{ allowed: boolean, retryAfter?: number }}
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateMap.set(ip, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true };
}

// ─── Main Handler ────────────────────────────────────────────────────────

/**
 * Cloudflare Pages Function handler for POST /api/ask
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  // Only POST
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Rate limit
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateCheck = checkRateLimit(ip);
  if (!rateCheck.allowed) {
    return new Response(
      JSON.stringify({ error: 'rate_limited', retryAfter: rateCheck.retryAfter }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(rateCheck.retryAfter) }
      }
    );
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  const { question, history } = body;
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return new Response(
      JSON.stringify({ error: 'invalid_input', message: 'question is required' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  console.log(
    `[ask] request ip=${ip} q="${question.trim().slice(0, 120)}" history_len=${(history || []).length}`
  );

  // Check credentials
  const openaiKey = env.OPENAI_API_KEY;
  const githubToken = env.GITHUB_TOKEN;
  if (!openaiKey) {
    return new Response(
      JSON.stringify({ error: 'config_missing', message: 'OPENAI_API_KEY not configured' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }

  // ─── Build streaming response ──────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Phase 1: Retrieval
        sendSSE(controller, 'status', { message: 'Searching portal data...' });
        const matched = retrieveEntities(question.trim());
        const matchedIds = [
          ...matched.repos.map((r) => r.id),
          ...matched.skills.map((s) => s.id),
          ...matched.domains.map((d) => d.id)
        ];
        sendSSE(controller, 'retrieval', {
          matched: matchedIds,
          repoCount: matched.repos.length,
          skillCount: matched.skills.length,
          domainCount: matched.domains.length
        });
        console.log(
          `[ask] retrieval q="${question.trim().slice(0, 80)}" repos=${matched.repos.length} skills=${matched.skills.length} domains=${matched.domains.length}`
        );

        // Phase 2: Build system prompt + prepare messages
        const systemPrompt = buildSystemPrompt(matched);
        const MAX_HISTORY = 10;
        const recentHistory = (history || []).slice(-MAX_HISTORY * 2); // 10 user+assistant pairs
        const messages = [...recentHistory, { role: 'user', content: question.trim() }];

        // Phase 3: Tool-call loop
        let toolRounds = 0;
        const MAX_TOOL_ROUNDS = 3;
        const MAX_DOC_READS = 2;
        let docReads = 0;
        const citations = [];
        let finalContent = '';

        while (toolRounds < MAX_TOOL_ROUNDS) {
          toolRounds++;

          let dsRes;
          try {
            dsRes = await callOpenAI({
              systemPrompt,
              messages,
              apiKey: openaiKey,
              stream: false
            });
          } catch (dsErr) {
            const isTimeout = dsErr.name === 'AbortError' || dsErr.name === 'TimeoutError';
            sendSSE(controller, 'error', {
              code: isTimeout ? 'openai_timeout' : 'openai_network_error',
              message: isTimeout
                ? 'OpenAI API timed out. Please try again.'
                : `OpenAI API network error: ${dsErr.message}`
            });
            controller.close();
            return;
          }

          if (!dsRes.ok) {
            const errText = await dsRes.text().catch(() => 'unknown error');
            sendSSE(controller, 'error', {
              code: 'openai_api_error',
              message: `OpenAI API error ${dsRes.status}`,
              detail: errText.slice(0, 300)
            });
            controller.close();
            return;
          }

          const dsData = await dsRes.json();
          const choice = dsData.choices?.[0];
          const msg = choice?.message;

          const hasToolCalls = msg?.tool_calls && msg.tool_calls.length > 0;
          console.log(
            `[ask] openai round=${toolRounds} status=${dsRes.status} tool_calls=${hasToolCalls ? msg.tool_calls.length : 0} content_len=${(msg?.content || '').length}`
          );

          if (!msg) {
            sendSSE(controller, 'error', {
              code: 'openai_empty_response',
              message: 'No response from OpenAI'
            });
            controller.close();
            return;
          }

          // Check for tool calls
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            // Append assistant message with tool calls
            messages.push({
              role: 'assistant',
              content: msg.content || '',
              tool_calls: msg.tool_calls
            });

            for (const tc of msg.tool_calls) {
              const fnName = tc.function?.name;
              let fnArgs;
              try {
                fnArgs = JSON.parse(tc.function?.arguments || '{}');
              } catch (parseErr) {
                console.error(`[ask] tool args parse error tool=${fnName} err=${parseErr.message}`);
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: JSON.stringify({ error: `invalid tool arguments: ${parseErr.message}` })
                });
                continue;
              }

              if (fnName === 'read_repo_doc') {
                if (docReads >= MAX_DOC_READS) {
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: 'max doc reads reached' })
                  });
                  continue;
                }
                docReads++;

                sendSSE(controller, 'tool_start', {
                  tool: 'read_repo_doc',
                  args: { repoId: fnArgs.repoId, docKey: fnArgs.docKey }
                });

                const repoCheck = reposById.get(fnArgs.repoId);
                if (!repoCheck) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_repo_doc',
                    status: 'error',
                    error: `unknown repo: ${fnArgs.repoId}`
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                      error: `unknown repo: ${fnArgs.repoId}. Valid repos: ${REPOS.map((r) => r.id).join(', ')}`
                    })
                  });
                  continue;
                }

                const docResolve = resolveDocKey(fnArgs.docKey);
                if (docResolve.error) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_repo_doc',
                    status: 'error',
                    error: docResolve.error
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: docResolve.error })
                  });
                  continue;
                }

                const guard = guardFilePath(docResolve.path);
                if (!guard.safe) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_repo_doc',
                    status: 'error',
                    error: guard.reason
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: guard.reason })
                  });
                  continue;
                }

                if (!githubToken) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_repo_doc',
                    status: 'error',
                    error: 'GITHUB_TOKEN not configured'
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: 'github_token_missing' })
                  });
                  continue;
                }

                const result = await fetchFromGitHub(fnArgs.repoId, docResolve.path, githubToken);
                if (result.error) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_repo_doc',
                    status: 'error',
                    error: result.error
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: result.error })
                  });
                } else {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_repo_doc',
                    status: 'ok',
                    bytes: result.size,
                    truncated: result.truncated || false
                  });
                  citations.push({ type: 'repo', id: fnArgs.repoId, file: result.path });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                      path: result.path,
                      content: result.content,
                      truncated: result.truncated || false
                    })
                  });
                }
              } else if (fnName === 'read_skill_file') {
                if (docReads >= MAX_DOC_READS) {
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                      error: 'max doc reads reached — answer from catalog data only'
                    })
                  });
                  continue;
                }
                docReads++;

                sendSSE(controller, 'tool_start', {
                  tool: 'read_skill_file',
                  args: { skillId: fnArgs.skillId }
                });

                const skill = skillsById.get(fnArgs.skillId);
                if (!skill) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_skill_file',
                    status: 'error',
                    error: `unknown skill: ${fnArgs.skillId}`
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                      error: `unknown skill: ${fnArgs.skillId}. Valid skills listed in the catalog.`
                    })
                  });
                  continue;
                }

                if (!githubToken) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_skill_file',
                    status: 'error',
                    error: 'GITHUB_TOKEN not configured'
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: 'github_token_missing' })
                  });
                  continue;
                }

                const skillPath = resolveSkillPath(skill);
                // Extract repo path: 'retailpulses-agent-skills/skills/account/foo/SKILL.md' -> repo='retailpulses-agent-skills', path='skills/account/foo/SKILL.md'
                const pathParts = skillPath.split('/');
                const skillRepo = pathParts[0];
                const skillFilePath = pathParts.slice(1).join('/');

                const result = await fetchFromGitHub(skillRepo, skillFilePath, githubToken);
                if (result.error) {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_skill_file',
                    status: 'error',
                    error: result.error
                  });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({ error: result.error })
                  });
                } else {
                  sendSSE(controller, 'tool_result', {
                    tool: 'read_skill_file',
                    status: 'ok',
                    bytes: result.size,
                    truncated: result.truncated || false
                  });
                  citations.push({ type: 'skill', id: fnArgs.skillId, file: skillPath });
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                      skillId: fnArgs.skillId,
                      path: skillPath,
                      content: result.content,
                      truncated: result.truncated || false
                    })
                  });
                }
              } else {
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: JSON.stringify({ error: `unknown tool: ${fnName}` })
                });
              }
            }
            // Continue loop for next LLM response
            continue;
          }

          // No tool calls — this is the final answer
          finalContent = msg.content || '';
          // Also add catalog entities to citations if relevant
          for (const { id } of matched.repos) {
            if (!citations.some((c) => c.type === 'repo' && c.id === id)) {
              citations.push({ type: 'repo', id });
            }
          }
          for (const { id } of matched.skills) {
            if (!citations.some((c) => c.type === 'skill' && c.id === id)) {
              citations.push({ type: 'skill', id });
            }
          }
          for (const { id } of matched.domains) {
            if (!citations.some((c) => c.type === 'domain' && c.id === id)) {
              citations.push({ type: 'domain', id });
            }
          }
          break;
        }

        // Phase 4: Stream the final answer
        if (finalContent) {
          // Stream tokens character by character (simple approach) or in chunks
          const chunks = finalContent.match(/.{1,50}/g) || [finalContent];
          for (const chunk of chunks) {
            sendSSE(controller, 'token', { text: chunk });
          }
        }

        // Phase 5: Final event with citations
        sendSSE(controller, 'final', {
          content: finalContent,
          citations,
          toolRounds,
          docReads
        });

        console.log(
          `[ask] final content_len=${finalContent.length} citations=${citations.length} tool_rounds=${toolRounds} doc_reads=${docReads}`
        );

        controller.close();
      } catch (err) {
        console.error(
          `[ask] error name="${err.name}" message="${err.message}" stack="${(err.stack || '').slice(0, 200)}"`
        );
        try {
          sendSSE(controller, 'error', {
            code: 'internal_error',
            message: err.message || 'Internal error'
          });
        } catch (sendErr) {
          console.error(`[ask] sendSSE in catch failed: ${sendErr.message}`);
        }
        try {
          controller.close();
        } catch (closeErr) {
          console.error(`[ask] controller.close in catch failed: ${closeErr.message}`);
        }
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
