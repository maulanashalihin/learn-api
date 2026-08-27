// Shared domain types — dipakai oleh REST, GraphQL, Webhooks, SSE
// Supaya kita bisa bandingkan "same data, different protocol"

export interface Task {
	id: string;
	title: string;
	done: boolean;
	createdAt: string; // ISO 8601
}

export type NewTask = Pick<Task, "title">;

// In-memory store. Simple Map, no DB needed for learning.
// Di production, ganti dengan PostgreSQL, Redis, dll.
export const taskStore = new Map<string, Task>();

// Helper: generate ID tanpa dependency eksternal
export function generateId(): string {
	return crypto.randomUUID();
}

// Seed data supaya gak kosong saat pertama kali jalan
export function seedTasks(): void {
	if (taskStore.size > 0) return;
	const seeds: Task[] = [
		{
			id: generateId(),
			title: "Belajar REST API",
			done: true,
			createdAt: new Date().toISOString(),
		},
		{
			id: generateId(),
			title: "Belajar GraphQL",
			done: false,
			createdAt: new Date().toISOString(),
		},
		{
			id: generateId(),
			title: "Belajar WebSockets",
			done: false,
			createdAt: new Date().toISOString(),
		},
	];
	for (const t of seeds) taskStore.set(t.id, t);
}
