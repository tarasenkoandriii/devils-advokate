// Фаза C ТЗ domain-ui — клиент media-review (Пункт 40 backend, ранее без UI).
import { apiGet, apiPatch, apiPost } from './api';

export interface YouTubeSearchResult { videoId: string; title: string; channelName: string; thumbnailUrl: string; durationSeconds: number | null; publishedAt: string | null }
export interface MediaReviewQueue { id: string; title: string; createdAt: string; _count?: { items: number } }
export interface MediaReviewQueueItem {
  id: string; orderIndex: number; status: 'AWAITING_UPLOAD' | 'READY' | 'PROCESSING' | 'DONE' | string;
  youtubeVideoId: string; title: string; channelName: string; thumbnailUrl: string; durationSeconds?: number | null; conversationId?: string | null;
  conversation?: { status: string; projectId: string } | null;
}
export interface MediaReviewSummary { totalItems: number; doneItems: number; manipulationSignals: number; discrepancySignals: number }

export const mediaReviewApi = {
  search: (query: string) => apiGet<YouTubeSearchResult[]>(`/media-review/youtube-search?query=${encodeURIComponent(query)}`),
  listQueues: () => apiGet<MediaReviewQueue[]>('/media-review/queues'),
  createQueue: (title: string) => apiPost<MediaReviewQueue>('/media-review/queues', { title }),
  getQueue: (id: string) => apiGet<MediaReviewQueue & { items: MediaReviewQueueItem[] }>(`/media-review/queues/${id}`),
  addItem: (queueId: string, r: YouTubeSearchResult) =>
    apiPost<MediaReviewQueueItem>(`/media-review/queues/${queueId}/items`, {
      youtubeVideoId: r.videoId, title: r.title, channelName: r.channelName, thumbnailUrl: r.thumbnailUrl,
      durationSeconds: r.durationSeconds ?? undefined, publishedAt: r.publishedAt ?? undefined,
    }),
  getSummary: (id: string) => apiGet<MediaReviewSummary>(`/media-review/queues/${id}/summary`),
  linkConversation: (itemId: string, conversationId: string) => apiPatch<MediaReviewQueueItem>(`/media-review/queue-items/${itemId}/link-conversation`, { conversationId }),
};
