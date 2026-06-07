export function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span className="stat-pill">
      <span>{label}</span>
      <strong>
        {label} {value}
      </strong>
    </span>
  );
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
