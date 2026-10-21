import { useState } from 'react';
import { Card, DataTable, PageHead, Pagination } from '@/components/ui';
import { usePagedQuery } from '@/hooks/useApi';
import { fmt } from '@/lib/format';

interface Row {
  id: string;
  at: string;
  admin: string | null;
  action: string;
  description: string;
  school: string | null;
  ip: string | null;
}

/** Everything platform admins did: schools created and changed, support access, admin changes. */
export default function AuditPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const q = usePagedQuery<Row>('/platform/audit', { page, pageSize });
  return (
    <>
      <PageHead title="Audit trail" sub="What We School's admins did, including every support visit to a school" crumbs={false} />
      <Card flush foot={<Pagination meta={q.data?.meta} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />}>
        <DataTable
          rows={q.data?.rows}
          loading={q.isLoading}
          rowKey={(r) => r.id}
          emptyText="Nothing yet."
          columns={[
            { key: 'at', label: 'When', render: (r) => <span className="t-xs t-muted">{fmt.dateTime(r.at)}</span>, width: '170px' },
            { key: 'admin', label: 'By', render: (r) => r.admin ?? '—' },
            { key: 'school', label: 'School', render: (r) => r.school ?? <span className="t-faint">—</span> },
            { key: 'description', label: 'What happened' },
            { key: 'ip', label: 'From', render: (r) => <span className="t-micro t-muted">{r.ip ?? ''}</span> },
          ]}
        />
      </Card>
    </>
  );
}
