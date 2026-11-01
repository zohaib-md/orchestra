<script setup lang="ts">
import { useGet, fmtTime } from "../api";

interface Overview {
  tickets: Record<string, number>;
  assignments: Record<string, number>;
  triggers: number;
  threads: number;
  events: number;
  failures: number;
}

interface EventRecord {
  id: number;
  at: number;
  kind: string;
  ticketId: string | null;
  data: Record<string, unknown>;
}

const { data, error, loading, load } = useGet<Overview>("/api/overview");
const { data: recent } = useGet<EventRecord[]>("/api/events?limit=8");

function sum(obj: Record<string, number>): number {
  return Object.values(obj).reduce((a, b) => a + b, 0);
}
</script>

<template>
  <div>
    <h2>Overview</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data" class="row">
      <div class="card">
        <div class="value">{{ sum(data.tickets) }}</div>
        <div class="label">Tickets ({{ data.tickets.open ?? 0 }} open)</div>
      </div>
      <div class="card">
        <div class="value">{{ data.assignments.pending ?? 0 }}</div>
        <div class="label">Pending</div>
      </div>
      <div class="card">
        <div class="value">{{ data.assignments.running ?? 0 }}</div>
        <div class="label">Running</div>
      </div>
      <div class="card">
        <div class="value">{{ data.assignments.waiting ?? 0 }}</div>
        <div class="label">Waiting</div>
      </div>
      <div class="card">
        <div class="value">{{ data.assignments.completed ?? 0 }}</div>
        <div class="label">Completed</div>
      </div>
      <div class="card">
        <div class="value" :class="{ error: data.failures > 0 }">{{ data.failures }}</div>
        <div class="label">Failed</div>
      </div>
      <div class="card">
        <div class="value">{{ data.triggers }}</div>
        <div class="label">Triggers</div>
      </div>
      <div class="card">
        <div class="value">{{ data.threads }}</div>
        <div class="label">Threads</div>
      </div>
    </div>

    <div v-if="recent" class="panel">
      <h2>Recent events</h2>
      <table>
        <thead>
          <tr><th>Time</th><th>Kind</th><th>Ticket</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in recent" :key="e.id">
            <td class="muted">{{ fmtTime(e.at) }}</td>
            <td class="mono">{{ e.kind }}</td>
            <td class="mono muted">{{ e.ticketId ?? "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
