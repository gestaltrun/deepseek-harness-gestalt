'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  getStatus: () => ipcRenderer.invoke('updater:getStatus'),
  checkNow: () => { ipcRenderer.send('updater:checkNow') },
  downloadNow: () => { ipcRenderer.send('updater:downloadNow') },
  quitAndInstall: () => { ipcRenderer.send('updater:quitAndInstall') },
  onStatus: (listener) => {
    const wrapped = (_event, status) => { listener(status) }
    ipcRenderer.on('updater:status-changed', wrapped)
    return () => { ipcRenderer.removeListener('updater:status-changed', wrapped) }
  },
  windowMinimize: () => { ipcRenderer.send('window:minimize') },
  windowMaximize: () => { ipcRenderer.send('window:maximize') },
  windowClose: () => { ipcRenderer.send('window:close') },
  accountGetSnapshot: () => ipcRenderer.invoke('account:getSnapshot'),
  accountAcceptPrivacy: () => ipcRenderer.invoke('account:acceptPrivacy'),
  accountBeginLogin: () => ipcRenderer.invoke('account:beginLogin'),
  accountSignOut: () => ipcRenderer.invoke('account:signOut'),
  onAccountSnapshot: (listener) => {
    const wrapped = (_event, snapshot) => { listener(snapshot) }
    ipcRenderer.on('account:snapshot-changed', wrapped)
    return () => { ipcRenderer.removeListener('account:snapshot-changed', wrapped) }
  },
  projectMembership: {
    createProject: (input) => ipcRenderer.invoke('projectMembership:create', input),
    projectByRemote: (normalizedRemoteUrl) => ipcRenderer.invoke('projectMembership:byRemote', normalizedRemoteUrl),
    roster: (projectId) => ipcRenderer.invoke('projectMembership:roster', projectId),
    invite: (input) => ipcRenderer.invoke('projectMembership:invite', input),
    decideInvitation: (invitationId, input) => ipcRenderer.invoke('projectMembership:decide', { invitationId, input }),
    retractInvitation: (invitationId) => ipcRenderer.invoke('projectMembership:retract', invitationId),
    pendingInvitations: () => ipcRenderer.invoke('projectMembership:pending'),
    issuedInvitations: (projectId) => ipcRenderer.invoke('projectMembership:issued', projectId),
    changeRole: (membershipId, role) => ipcRenderer.invoke('projectMembership:changeRole', { membershipId, role }),
    setMemberTags: (membershipId, tags) => ipcRenderer.invoke('projectMembership:setTags', { membershipId, tags }),
    removeMember: (membershipId) => ipcRenderer.invoke('projectMembership:remove', membershipId),
  },
  pairingGetSnapshot: () => ipcRenderer.invoke('pairing:getSnapshot'),
  pairingSetEnabled: (enabled) => ipcRenderer.invoke('pairing:setEnabled', enabled),
  pairingCreateChallenge: () => ipcRenderer.invoke('pairing:createChallenge'),
  pairingCancelChallenge: () => ipcRenderer.invoke('pairing:cancelChallenge'),
  pairingConfirm: (pendingPairingId) => ipcRenderer.invoke('pairing:confirm', pendingPairingId),
  pairingReject: (pendingPairingId) => ipcRenderer.invoke('pairing:reject', pendingPairingId),
  pairingRevoke: (pairingId) => ipcRenderer.invoke('pairing:revoke', pairingId),
  onPairingSnapshot: (listener) => {
    const wrapped = (_event, snapshot) => { listener(snapshot) }
    ipcRenderer.on('pairing:snapshot-changed', wrapped)
    return () => { ipcRenderer.removeListener('pairing:snapshot-changed', wrapped) }
  },
  sub2ApiGetSnapshot: () => ipcRenderer.invoke('sub2api:getSnapshot'),
  sub2ApiEnable: () => ipcRenderer.invoke('sub2api:enable'),
  sub2ApiDisable: () => ipcRenderer.invoke('sub2api:disable'),
  sub2ApiUninstall: (deleteData) => ipcRenderer.invoke('sub2api:uninstall', deleteData === true),
  onSub2ApiSnapshot: (listener) => {
    const wrapped = (_event, snapshot) => { listener(snapshot) }
    ipcRenderer.on('sub2api:snapshot-changed', wrapped)
    return () => { ipcRenderer.removeListener('sub2api:snapshot-changed', wrapped) }
  },
  browserPresent: (request) => ipcRenderer.invoke('browser:present', request),
  browserConceal: (target) => ipcRenderer.invoke('browser:conceal', target),
  chromeOverlayShow: (request) => ipcRenderer.invoke('chrome:overlayShow', request),
  chromeOverlayHide: () => ipcRenderer.invoke('chrome:overlayHide'),
  chromeOverlayGetState: () => ipcRenderer.invoke('chrome:overlayGetState'),
  chromeOverlayResult: (result) => { ipcRenderer.send('chrome:overlay-result', result) },
  onChromeOverlayState: (listener) => {
    const wrapped = (_event, state) => { listener(state) }
    ipcRenderer.on('chrome:overlay-state', wrapped)
    return () => { ipcRenderer.removeListener('chrome:overlay-state', wrapped) }
  },
  onChromeOverlayResult: (listener) => {
    const wrapped = (_event, result) => { listener(result) }
    ipcRenderer.on('chrome:overlay-result', wrapped)
    return () => { ipcRenderer.removeListener('chrome:overlay-result', wrapped) }
  },
})
