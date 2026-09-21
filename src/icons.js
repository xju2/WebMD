// Outline icons on a 24px grid, drawn with round caps at one stroke width so
// the rail, sidebar, and toolbars read as one set. Each entry is a list of SVG
// path `d` strings; App.svelte's `icon` snippet renders them.
export const ICONS = {
  home: ['M3.5 11 12 4l8.5 7', 'M5.5 9.5V20h13V9.5', 'M10 20v-5.5h4V20'],
  today: [
    'M6.5 3.5h7l4 4v13h-11z',
    'M13.5 3.5v4h4',
    'M9.5 12.5h5',
    'M9.5 16h3.5'
  ],
  folder: [
    'M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.3l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z'
  ],
  tasks: [
    'm4 7.5 2 2 3.5-4',
    'm4 16.5 2 2 3.5-4',
    'M12.5 7.5H20',
    'M12.5 16.5H20'
  ],
  news: [
    'M5 5.5h11v13.5H6.5A1.5 1.5 0 0 1 5 17.5z',
    'M16 9h3v8.5a1.5 1.5 0 0 1-3 0',
    'M8 9h5',
    'M8 12.5h5',
    'M8 16h3'
  ],
  // A lectern screen: a talk being given, which is what an Indico meeting is.
  meetings: [
    'M4 5h16',
    'M5.5 5v9a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5',
    'M12 15v4',
    'M8.5 20 12 18.5l3.5 1.5',
    'M9 9.5h6',
    'M9 12h3.5'
  ],
  external: [
    'M13.5 4.5H19.5V10.5',
    'M19.5 4.5 11 13',
    'M17 13.5v5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5'
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  lock: ['M8 10.5V8a4 4 0 0 1 8 0v2.5', 'M6.5 10.5h11v9h-11z'],
  video: ['M3.5 7h11v10h-11z', 'm14.5 10.5 6-3.5v10l-6-3.5'],
  sparkles: [
    'm11 4 1.7 4.8L17.5 10.5l-4.8 1.7L11 17l-1.7-4.8-4.8-1.7 4.8-1.7z',
    'm18 14.5.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'
  ],
  file: ['M7 3.5h6.5L18 8v12.5H7z', 'M13.5 3.5V8H18'],
  chevronRight: ['m9.5 6 6 6-6 6'],
  chevronLeft: ['m14.5 6-6 6 6 6'],
  chevronDown: ['m6 9.5 6 6 6-6'],
  search: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'm20 20-4.8-4.8'],
  refresh: [
    'M19.5 11A7.5 7.5 0 0 0 6.2 6.8L4.5 8.5',
    'M4.5 4.5v4h4',
    'M4.5 13a7.5 7.5 0 0 0 13.3 4.2l1.7-1.7',
    'M19.5 19.5v-4h-4'
  ],
  collapseAll: ['m8 4.5 4 4 4-4', 'm8 19.5 4-4 4 4'],
  expandAll: ['m8 8.5 4-4 4 4', 'm8 15.5 4 4 4-4'],
  clip: [
    'M7 3.5h6.5L18 8v12.5H7z',
    'M13.5 3.5V8H18',
    'M12.5 11.5v5',
    'M10 14h5'
  ],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  more: [
    'M5.5 12h.01',
    'M12 12h.01',
    'M18.5 12h.01'
  ],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  panelLeft: [
    'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5z',
    'M9.5 4.5v15',
    'm15.5 10-2 2 2 2'
  ],
  panelRight: [
    'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5z',
    'M14.5 4.5v15',
    'm8.5 10 2 2-2 2'
  ],
  expandWide: ['M4 12h16', 'm8 8-4 4 4 4', 'm16 8 4 4-4 4'],
  collapseWide: ['M3 12h6', 'M15 12h6', 'm6 9 3 3-3 3', 'm18 9-3 3 3 3']
};
