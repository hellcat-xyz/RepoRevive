import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ResurrectionView } from '@/components/ResurrectionView';
import { JOB_ID_RE } from '@/lib/types';

export const metadata: Metadata = { title: 'Resurrection in progress' };

export default async function ResurrectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!JOB_ID_RE.test(id)) notFound();
  return <ResurrectionView id={id} />;
}
