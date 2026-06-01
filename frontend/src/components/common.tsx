import { For, Show } from "solid-js";
import { pretty } from "../api";

export function TerminalPanel(props: { title: string; value: unknown; level?: "ok" | "warn" | "err" }) {
  return (
    <section class="terminal-card">
      <div class="terminal-title">
        <span class="dot red" />
        <span class="dot yellow" />
        <span class="dot green" />
        <span class="mono">{props.title}</span>
        <Show when={props.level}>
          <span class={`badge ${props.level}`}>{props.level}</span>
        </Show>
      </div>
      <pre>{typeof props.value === "string" ? props.value : pretty(props.value)}</pre>
    </section>
  );
}

export function Field(props: { label: string; value: string; onInput: (value: string) => void; type?: string; placeholder?: string }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type={props.type || "text"}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

export function SelectField<T extends string>(props: { label: string; value: T; options: readonly T[]; onInput: (value: T) => void }) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <select value={props.value} onInput={(event) => props.onInput(event.currentTarget.value as T)}>
        <For each={props.options}>{(item) => <option value={item}>{item}</option>}</For>
      </select>
    </label>
  );
}
