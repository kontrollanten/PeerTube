import { Injectable } from '@angular/core';
import { SwPush, SwUpdate } from '@angular/service-worker'
import { HooksService } from '@app/core/plugins/hooks.service'

@Injectable()
export class ServiceWorkerService {
  constructor(
    private hooks: HooksService,
    private swPush: SwPush,
    private updates: SwUpdate
    ) {
  }

  async subscribe() {
    this.updates.available.subscribe(event => {
        this.hooks.runAction('action:service-worker.available', 'common', { event, swPush: this.swPush })
    });
    this.updates.activated.subscribe(event => {
        this.hooks.runAction('action:service-worker.activated', 'common', { event, swPush: this.swPush })
    });
  }
}