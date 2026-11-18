/** État du dossier de livraison : monté ? accessible en écriture ? */
import { checkDeliveryTarget } from "@/lib/delivery/drive";
import { prisma } from "@/lib/db";
import { json } from "@/lib/api";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const target = await checkDeliveryTarget();
  const recent = await prisma.delivery.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { clip: { select: { title: true } }, client: { select: { name: true } } },
  });
  return json({
    ok: true,
    target,
    auto: config.delivery.auto,
    publicBase: config.delivery.publicBase || null,
    recent: recent.map((d) => ({
      id: d.id,
      clip: d.clip.title,
      client: d.client?.name ?? null,
      path: d.filePath,
      status: d.status,
      error: d.error,
      at: d.deliveredAt,
    })),
  });
}
