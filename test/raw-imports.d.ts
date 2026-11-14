// Vite/Vitest `?raw` imports load a file's text as a string (used to read SQL migrations in tests).
declare module '*?raw' {
  const content: string;
  export default content;
}
