<script setup lang="ts">
import { useGet, fmtTime } from "../api";

interface LlmCall {
  id: number;
  at: number;
  ticketId: string | null;
  data: {
    model: string;
    role: string;
    latencyMs: number;
    ok: boolean;
    error?: string;
    usage?: { promptTokens: number; completionTokens: number };
  };
}

interface LlmStats {
  total: number;
  errors: number;
  avgLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  calls: LlmCall[];
}

const { data, error, loading, load } = useGet<LlmStats>("/api/llm");
</script>

<template>
  <div>
    <h2>LLM observability</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data">
      <div class="row">
        <div class="card"><div class="value">{{ data.total }}</div><div class="label">Calls</div></div>
        <div class="card"><div class="value" :class="{ error: data.errors > 0 }">{{ data.errors }}</div><div class="label">Errors</div></div>
        <div class="card"><div class="value">{{ data.avgLatencyMs.toFixed(0) }}ms</div><div class="label">Avg latency</div></div>
        <div class="card"><div class="value">{{ data.promptTokens }}</div><div class="label">Prompt tokens</div></div>
        <div class="card"><div class="value">{{ data.completionTokens }}</div><div class="label">Completion tokens</div></div>
      </div>

      <div class="panel">
        <table>
          <thead>
            <tr><th>Time</th><th>Model</th><th>Role</th><th>Latency</th><th>OK</th><th>Tokens</th><th>Ticket</th><th>Error</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in data.calls" :key="c.id">
              <td class="muted">{{ fmtTime(c.at) }}</td>
              <td class="mono">{{ c.data.model }}</td>
              <td>{{ c.data.role }}</td>
              <td class="muted">{{ c.data.latencyMs }}ms</td>
              <td><span class="badge" :class="c.data.ok ? 'ok' : 'bad'">{{ c.data.ok ? "ok" : "error" }}</span></td>
              <td class="mono muted">{{ c.data.usage ? `${c.data.usage.promptTokens}/${c.data.usage.completionTokens}` : "—" }}</td>
              <td class="mono muted">{{ c.ticketId ?? "—" }}</td>
              <td class="error">{{ c.data.error ?? "" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
