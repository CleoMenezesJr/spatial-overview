import neostandard from 'neostandard';

export default [
    ...neostandard({
        style: false,
        noStyle: true,
    }),
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                global: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                _: 'readonly',
                ngettext: 'readonly',
                C_: 'readonly',
                N_: 'readonly',
                getClass: 'readonly',
            },
        },
        rules: {
            '@stylistic/indent': 'off',
            '@stylistic/semi': 'off',
            '@stylistic/space-before-function-paren': 'off',
            '@stylistic/comma-dangle': 'off',
            '@stylistic/no-mixed-spaces-and-tabs': 'off',
            '@stylistic/no-tabs': 'off',
            curly: 'off',
            'no-unused-vars': ['warn', {args: 'none', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}],
            'no-undef': 'warn',
            'prefer-const': 'warn',
            'no-var': 'error',
            'no-useless-call': 'off',
        },
    },
    {
        ignores: ['node_modules/', '.opencode/', '.superpowers/', 'docs/', 'eita.txt'],
    },
];
