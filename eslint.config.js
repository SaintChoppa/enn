import js from "@eslint/js";
import globals from "globals";

// ui/app.js es un único módulo cargado directamente por el navegador
// (`<script type="module">`, sin bundler) — nada de Node aquí salvo lo que
// window.__TAURI__ expone en tiempo de ejecución.
export default [
  js.configs.recommended,
  {
    files: ["ui/app.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // variables sin usar: aviso, no error — pasa con frecuencia en
      // parámetros de callback que se dejan por claridad de la firma
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
