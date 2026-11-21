import js from "@eslint/js";
import globals from "globals";

// Los módulos de ui/ los carga el navegador directamente
// (`<script type="module">`, sin bundler) — nada de Node aquí salvo lo que
// window.__TAURI__ expone en tiempo de ejecución.
export default [
  js.configs.recommended,
  {
    files: ["ui/app.js", "ui/palette.js", "ui/search.js", "ui/select.js", "ui/prefs.js", "ui/motion.js", "ui/perf.js", "ui/dl-anim.js", "ui/reco.js", "ui/lab.js", "ui/wave.js", "ui/modeswitch.js", "ui/viz/*.js"],
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
  {
    // pruebas de `npm test` (node --test): corren en Node, no en el navegador
    files: ["ui/tests/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
