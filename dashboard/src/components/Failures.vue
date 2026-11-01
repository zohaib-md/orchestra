<script setup lang="ts">
import { useGet, fmtTime } from "../api";

interface Ticket {
  id: string;
  state: string;
  mandate: { scope: string; requester: string };
}

interface Assignment {
  id: string;
  ticketId: string;
  workerId: string;
  state: string;
  startedAt: number | null;
  endedAt: number | null;
  report: { status: string; text: string | null } | null;
}

interface Failure {
  assignment: Assignment;
  ticket: Ticket | null;
}

const { data, error, loading, load } = useGet<Failure[]>("/api/failures");
</script>

<template>
  <div>
    <h2>Failures & recovery</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data && data.length === 0" class="panel muted">No failures.</div>
    <div v-else-if="data" class="panel">
      <table>
        <thead>
          <tr><th>Assignment</th><th>Ticket</th><th>Requester</th><th>Started</th><th>Error</th></tr>
        </thead>
        <tbody>
          <tr v-for="f in data" :key="f.assignment.id">
            <td class="mono">{{ f.assignment.workerId }}</td>
            <td class="mono muted">{{ f.ticket?.id ?? f.assignment.ticketId }}</td>
            <td>{{ f.ticket?.mandate.requester ?? "—" }}</td>
            <td class="muted">{{ fmtTime(f.assignment.startedAt) }}</td>
            <td class="error">{{ f.assignment.report?.text }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
