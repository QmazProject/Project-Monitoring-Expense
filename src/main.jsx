// env.js must be first: it publishes the Vite environment variables as
// globalThis.OE_CONFIG before App.jsx reads its CONFIG block.
import "./env.js";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
