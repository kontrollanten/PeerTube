import { Component, Input, AfterViewInit } from '@angular/core';
import { HooksService, PluginService } from '@app/core';
import { PluginElementPlaceholder } from '@peertube/peertube-models'

@Component({
  selector: 'my-plugin-placeholder',
  template: '<div [id]="getId()"></div>',
  styleUrls: [ './plugin-placeholder.component.scss' ]
})

export class PluginPlaceholderComponent implements AfterViewInit {
  @Input() pluginId: PluginElementPlaceholder
  @Input() context: any

  constructor(
    private hooks: HooksService
  ) {}

  ngAfterViewInit() {
    this.hooks.runAction('action:html-placeholder.loaded', 'common', {
      context: this.context,
      placeholderId: this.pluginId
    })
  }

  getId () {
    return 'plugin-placeholder-' + this.pluginId
  }
}
