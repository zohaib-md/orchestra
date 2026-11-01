<script setup lang="ts">
import { ref } from "vue";
import { useGet, fmtTime } from "../api";

interface Ticket {
  id: string;
  state: string;
  mandate: { scope: string; strength: string; requester: string; via: string };
  createdAt: number;
}

interface Assignment {
  id: string;
  state: string;
  workerId: string;
  startedAt: number | null;
  endedAt: number | null;
  report: { status: string; text: string | null } | null;
}

interface EventRecord {
  id: number;
  at: number;
  kind: string;
  data: Record<string, unknown>;
}

interface TicketDetail {
  ticket: Ticket;
  assignments: Assignment[];
  events: EventRecord[];
}

const { data, error, loading, load } = useGet<Ticket[]>("/api/tickets");
const selected = ref<string | null>(null);
const detail = ref<TicketDetail | null>(null);

async function select(id: string): Promise<void> {
  selected.value = id;
  const res = await fetch(`/api/tickets/${encodeURIComponent(id)}`);
  detail.value = await res.json();
}
</script>

<template>
  <div>
    <h2>Tickets</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data" class="panel">
      <table>
        <thead>
          <tr><th>Ticket</th><th>State</th><th>Requester</th><th>Scope</th><th>Created</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in data" :key="t.id">
            <td><button class="link" @click="select(t.id)">{{ t.id }}</button></td>
            <td><span class="badge" :class="t.state === 'open' ? 'ok' : 'neutral'">{{ t.state }}</span></td>
            <td>{{ t.mandate.requester }}</td>
            <td>{{ t.mandate.scope }}</td>
            <td class="muted">{{ fmtTime(t.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="detail" class="panel">
      <h2>Ticket {{ detail.ticket.id }}</h2>
      <div class="row">
        <div class="card"><div class="value">{{ detail.ticket.mandate.strength }}</div><div class="label">Strength</div></div>
        <div class="card"><div class="value">{{ detail.ticket.mandate.via }}</div><div class="label">Via</div></div>
        <div class="card"><div class="value">{{ detail.assignments.length }}</div><div class="label">Assignments</div></div>
      </div>

      <h3 class="muted">Assignments</h3>
      <table>
        <thead>
          <tr><th>Worker</th><th>State</th><th>Report</th></tr>
        </thead>
        <tbody>
          <tr v-for="a in detail.assignments" :key="a.id">
            <td class="mono">{{ a.workerId }}</td>
            <td><span class="badge" :class="a.state === 'ended' ? 'neutral' : 'ok'">{{ a.state }}</span></td>
            <td>{{ a.report?.status ?? "—" }} {{ a.report?.text ?? "" }}</td>
          </tr>
        </tbody>
      </table>

      <h3 class="muted">History</h3>
      <table>
        <thead>
          <tr><th>Time</th><th>Kind</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in detail.events" :key="e.id">
            <td class="muted">{{ fmtTime(e.at) }}</td>
            <td class="mono">{{ e.kind }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
