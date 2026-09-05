import "./styles.css"
import React from "react"
import ReactDOM from "react-dom/client"

import App from "./App"
import { installGlobalErrorLogging } from "./adapters/errorLog"

// Before the first render, so a throw while the tree is mounting is logged too.
installGlobalErrorLogging()

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
