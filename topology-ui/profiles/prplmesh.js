// The prplMesh lab's topology page: served by prplmesh-lab's controller-ui, which maps
// prplMesh's Data Elements onto the same /api/v1 contract; live topology, devices,
// clients and networks only, refreshed every two seconds; installed as static/ui-profile.js.
window.EASYMESH_UI_PROFILE = {
  stack: 'prplmesh',
  title: 'prplMesh EasyMesh Controller',
  logo: 'EasyMesh Controller',
  badge: 'prplMesh',
  wirelessLabel: 'Networks',
  defaultTab: 'topology',
  tabs: ['topology', 'devices', 'clients', 'wireless'],
  charts: false,
  websocket: false,
};
