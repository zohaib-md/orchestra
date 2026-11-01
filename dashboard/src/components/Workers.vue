<script setup lang="ts">
import { useGet, fmtTime, fmtDuration } from "../api";

interface Assignment {
  id: string;
  ticketId: string;
  workerId: string;
  state: string;
  startedAt: number | null;
  endedAt: number | null;
  heartbeatAt: number | null;
  progressAt: number | null;
  report: { status: string; text: string | null } | null;
}

const { data, error, loading, load } = useGet<Assignment[]>("/api/assignments");

function stateClass(state: string): string {
  if (state === "running") return "ok";
  if (state === "waiting") return "warn";
  if (state === "ended") return "neutral";
  return "neutral";
}
</script>

<template>
  <div>
    <h2>Workers</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data" class="panel">
      <table>
        <thead>
          <tr>
            <th>Worker</th><th>State</th><th>Ticket</th><th>Started</th>
            <th>Duration</th><th>Last heartbeat</th><th>Last progress</th><th>Report</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in data" :key="a.id">
            <td class="mono">{{ a.workerId }}</td>
            <td><span class="badge" :class="stateClass(a.state)">{{ a.state }}</span></td>
            <td class="mono muted">{{ a.ticketId }}</td>
            <td class="muted">{{ fmtTime(a.startedAt) }}</td>
            <td class="muted">{{ fmtDuration(a.startedAt, a.endedAt) }}</td>
            <td class="muted">{{ fmtTime(a.heartbeatAt) }}</td>
            <td class="muted">{{ fmtTime(a.progressAt) }}</td>
            <td>{{ a.report?.status ?? "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
