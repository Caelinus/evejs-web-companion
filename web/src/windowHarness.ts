// DEV-ONLY entry for the window chrome harness. See WindowHarness.svelte for
// what it is and why. Not part of the build: `vite.config.ts` builds
// `web/index.html` only, so nothing here reaches `public/dist`. Open it with
// `npm run dev:web` at /window-harness.html.
import "./styles.css";
import { mount } from "svelte";
import WindowHarness from "./ui/WindowHarness.svelte";

const host = document.getElementById("harness");
if (host) mount(WindowHarness, { target: host });
