import sveltePlugin from 'eslint-plugin-svelte';

export default [
  {
    ignores: ['build/', '.svelte-kit/', 'node_modules/']
  },
  ...sveltePlugin.configs['flat/recommended'],
  {
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
];
