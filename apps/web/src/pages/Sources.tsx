import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/layout/Card";
import { AddSourceDialog } from "@/components/AddSourceDialog";
import { SourceTree } from "@/components/sources/SourceTree";
import { useSession, isOperator } from "@/lib/session";

export default function Sources() {
  const { me } = useSession();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Sources" actions={isOperator(me) ? <AddSourceDialog /> : undefined} />
      <Card bleedMobile>
        <SourceTree />
      </Card>
    </div>
  );
}
