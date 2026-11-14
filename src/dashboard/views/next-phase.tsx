/** Placeholder body for the five destinations that are rebuilt in the next phase (D-04). */
export default function NextPhaseView({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">This page is rebuilt in the next phase.</p>
    </div>
  );
}
