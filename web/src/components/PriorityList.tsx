import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProviderAccountRecord, PrioritySortMode } from "../api/client.js";

interface PriorityListProps {
  accounts: ProviderAccountRecord[];
  mode: PrioritySortMode;
  onReorder: (accounts: ProviderAccountRecord[]) => void;
}

export default function PriorityList({ accounts, mode, onReorder }: PriorityListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const isManual = mode === "manual";

  function accountKey(a: ProviderAccountRecord): string {
    return `${a.providerName}:${a.accountIndex}`;
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = accounts.findIndex((a) => accountKey(a) === active.id);
    const newIndex = accounts.findIndex((a) => accountKey(a) === over.id);
    onReorder(arrayMove(accounts, oldIndex, newIndex));
  }

  if (!isManual) {
    return (
      <ol className="flex flex-col gap-1.5">
        {accounts.map((a, i) => (
          <li
            key={accountKey(a)}
            className="flex items-center gap-3 rounded-md border border-base-border bg-base-panel px-3 py-2 text-sm"
          >
            <span className="font-mono text-xs text-ink-faint w-4">{i + 1}</span>
            <span className="text-ink-primary truncate">{a.label ?? a.providerName}</span>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={accounts.map(accountKey)} strategy={verticalListSortingStrategy}>
        <ol className="flex flex-col gap-1.5">
          {accounts.map((a, i) => (
            <SortableRow key={accountKey(a)} id={accountKey(a)} rank={i + 1} account={a} />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  id,
  rank,
  account,
}: {
  id: string;
  rank: number;
  account: ProviderAccountRecord;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-md border border-base-border bg-base-panel px-3 py-2 text-sm cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-60" : ""
      }`}
      {...attributes}
      {...listeners}
    >
      <span aria-hidden="true" className="text-ink-faint select-none">
        ::
      </span>
      <span className="font-mono text-xs text-ink-faint w-4">{rank}</span>
      <span className="text-ink-primary truncate">{account.label ?? account.providerName}</span>
    </li>
  );
}
