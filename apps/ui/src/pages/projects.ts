import type { JsonView } from '../jr/page.tsx'

export const PROJECTS: JsonView = {
  data: { projects: 'projectsAll' },
  spec: {
    type: 'Page',
    props: { title: 'Projects' },
    children: [
      {
        type: 'Card',
        props: { noPad: true },
        children: [
          {
            type: 'DataTable',
            props: {
              rows: { $state: '/projects' },
              filter: true,
              filterFrom: ['project'],
              filterPlaceholder: 'filter…',
              initialSort: { key: 'totalDurationMs', desc: true },
              rowHref: '/projects/{project}',
              emptyTitle: 'No projects discovered',
              emptyCmd: 'vx run <task>',
              columns: [
                { key: 'project', label: 'Project', sortable: true, kind: 'dots', dots: [{ field: 'project', map: 'palette' }] },
                { key: 'runs', label: 'Runs', align: 'right', sortable: true },
                { key: 'failures', label: 'Failures', align: 'right', sortable: true, tone: { gt: 0, tone: 'danger' } },
                { key: 'hitRate', label: 'Hit %', align: 'right', sortable: true, kind: 'percent0', baseTone: 'cache' },
                { key: 'totalDurationMs', label: 'Total time', align: 'right', sortable: true, kind: 'bar', format: 'duration', colorFrom: 'project' },
                { key: 'estimatedTimeSavedMs', label: 'Saved', align: 'right', sortable: true, kind: 'duration', baseTone: 'success' },
                { key: 'cacheBytes', label: 'Cache', align: 'right', sortable: true, kind: 'bytes' },
                { key: 'lastRunAt', label: 'Last run', align: 'right', sortable: true, kind: 'relativeTime', baseTone: 'faint' },
              ],
            },
          },
        ],
      },
    ],
  },
}
