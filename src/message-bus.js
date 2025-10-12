import { EventEmitter } from 'events';

export const MessageEvents = {
  STATUS_UPDATE: 'status:update',
  PLANNING_UPDATE: 'planning:update',
  ERROR: 'error',
  REQUEST: 'request',
  TEAM_MESSAGE: 'team:message',
};

function subscribe(emitter, event, listener) {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

export function createMessageBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);

  return {
    emitStatus(update) {
      emitter.emit(MessageEvents.STATUS_UPDATE, update);
    },
    emitPlanning(update) {
      emitter.emit(MessageEvents.PLANNING_UPDATE, update);
    },
    emitError(update) {
      emitter.emit(MessageEvents.ERROR, update);
    },
    emitRequest(update) {
      emitter.emit(MessageEvents.REQUEST, update);
    },
    emitTeamMessage(update) {
      emitter.emit(MessageEvents.TEAM_MESSAGE, update);
    },
    onStatus(listener) {
      return subscribe(emitter, MessageEvents.STATUS_UPDATE, listener);
    },
    onPlanning(listener) {
      return subscribe(emitter, MessageEvents.PLANNING_UPDATE, listener);
    },
    onError(listener) {
      return subscribe(emitter, MessageEvents.ERROR, listener);
    },
    onRequest(listener) {
      return subscribe(emitter, MessageEvents.REQUEST, listener);
    },
    onTeamMessage(listener) {
      return subscribe(emitter, MessageEvents.TEAM_MESSAGE, listener);
    },
    removeAll() {
      emitter.removeAllListeners();
    },
  };
}
