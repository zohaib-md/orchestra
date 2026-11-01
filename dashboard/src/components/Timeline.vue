<script setup lang="ts">
import { useGet, fmtTime } from "../api";

interface EventRecord {
  id: number;
  at: number;
  kind: string;
  ticketId: string | null;
  assignmentId: string | null;
  data: Record<string, unknown>;
}

const { data, error, loading, load } = useGet<EventRecord[]>("/api/events?limit=200");

function kindClass(kind: string): string {
  if (kind.includes("failed") || kind.includes("recovered")) return "bad";
  if (kind.includes("delivered") || kind.includes("completed")) return "ok";
  if (kind.includes("waiting")) return "warn";
  return "neutral";
}
</script>

<template>
  <div>
    <h2>Event timeline</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data" class="panel">
      <table>
        <thead>
          <tr><th>Time</th><th>Kind</th><th>Ticket</th><th>Assignment</th><th>Data</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in data" :key="e.id">
            <td class="muted">{{ fmtTime(e.at) }}</td>
            <td><span class="badge" :class="kindClass(e.kind)">{{ e.kind }}</span></td>
            <td class="mono muted">{{ e.ticketId ?? "—" }}</td>
            <td class="mono muted">{{ e.assignmentId ?? "—" }}</td>
            <td class="mono muted">{{ JSON.stringify(e.data) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
