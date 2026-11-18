/**
 * Metricool en mode mock : même contrat que le client réel, posts conservés
 * en mémoire du processus. Permet de dérouler la file de publication et
 * l'UI calendrier sans compte Metricool.
 */
type StoredPost = Record<string, unknown> & { id: string; blogId?: string; createdAt: string };

const store = new Map<string, StoredPost>();
let counter = 1;

export const metricoolMock = {
  async listBrands() {
    return [
      { blogId: "mock-blog-1", label: "Marque principale (mock)" },
      { blogId: "mock-blog-2", label: "Compte secondaire (mock)" },
    ];
  },

  async normalizeImage(url: string) {
    return `${url}#mock-normalized`;
  },

  async schedulePost(payload: Record<string, unknown>, blogId?: string): Promise<StoredPost> {
    const id = `mock-post-${counter++}`;
    const post: StoredPost = { ...payload, id, blogId, createdAt: new Date().toISOString(), mock: true };
    store.set(id, post);
    return post;
  },

  async getPost(id: string) {
    return store.get(id) ?? null;
  },

  async deletePost(id: string) {
    store.delete(id);
  },

  all() {
    return [...store.values()];
  },
};
