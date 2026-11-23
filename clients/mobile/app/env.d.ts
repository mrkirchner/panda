// The TV client's shared code reads Vite's `import.meta.env`; webpack.config.js defines the
// values it reads on the phone. Typed as Vite types them.
interface ImportMeta {
  readonly env: {
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly [key: string]: string | undefined | boolean;
  } & { readonly [key: `VITE_${string}`]: string };
}
