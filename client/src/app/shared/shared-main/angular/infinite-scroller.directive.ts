import { fromEvent, Observable, Subscription } from 'rxjs'
import { distinctUntilChanged, filter, map, share, startWith, throttleTime } from 'rxjs/operators'
import { AfterViewChecked, Directive, ElementRef, EventEmitter, Inject, Input, OnDestroy, OnInit, Output, PLATFORM_ID } from '@angular/core'
import { PeerTubeRouterService, RouterSetting } from '@app/core'
import { isPlatformBrowser } from '@angular/common'

@Directive({
  selector: '[myInfiniteScroller]',
  standalone: true
})
export class InfiniteScrollerDirective implements OnInit, OnDestroy, AfterViewChecked {
  @Input() percentLimit = 70
  @Input() onItself = false
  @Input() dataObservable: Observable<any[]>

  // Add angular state in query params to reuse the routed component
  @Input() setAngularState: boolean
  @Input() parentDisabled = false

  @Output() nearOfBottom = new EventEmitter<void>()

  private decimalLimit = 0
  private lastCurrentBottom = -1
  private scrollDownSub: Subscription
  private container: HTMLElement

  private checkScroll = false

  constructor (
    @Inject(PLATFORM_ID) private platformId: object,
    private peertubeRouter: PeerTubeRouterService,
    private el: ElementRef
  ) {
    this.decimalLimit = this.percentLimit / 100
  }

  ngAfterViewChecked () {
    if (isPlatformBrowser(this.platformId) && this.checkScroll) {
      this.checkScroll = false

      // Wait HTML update
      setTimeout(() => {
        if (this.hasScroll() === false) this.nearOfBottom.emit()
      })
    }
  }

  ngOnInit () {
    if (isPlatformBrowser(this.platformId)) {
      this.initialize()
    }
  }

  ngOnDestroy () {
    if (this.scrollDownSub) this.scrollDownSub.unsubscribe()
  }

  initialize () {
    this.container = this.onItself
      ? this.el.nativeElement
      : document.documentElement

    // Emit the last value
    const throttleOptions = { leading: true, trailing: true }

    const scrollableElement = this.onItself ? this.container : window
    const scrollObservable = fromEvent(scrollableElement, 'scroll')
      .pipe(
        startWith(true),
        throttleTime(200, undefined, throttleOptions),
        map(() => this.getScrollInfo()),
        distinctUntilChanged((o1, o2) => o1.current === o2.current),
        share()
      )

    // Scroll Down
    this.scrollDownSub = scrollObservable
      .pipe(
        filter(({ current }) => this.isScrollingDown(current)),
        filter(({ current, maximumScroll }) => (current / maximumScroll) > this.decimalLimit)
      )
      .subscribe(() => {
        if (this.setAngularState && !this.parentDisabled) this.setScrollRouteParams()

        this.nearOfBottom.emit()
      })

    if (this.dataObservable) {
      this.dataObservable
          .pipe(filter(d => d.length !== 0))
          .subscribe(() => this.checkScroll = true)
    }
  }

  private getScrollInfo () {
    return { current: this.container.scrollTop, maximumScroll: this.getMaximumScroll() }
  }

  private getMaximumScroll () {
    const elementHeight = this.onItself ? this.container.clientHeight : window.innerHeight

    return this.container.scrollHeight - elementHeight
  }

  private hasScroll () {
    return this.getMaximumScroll() > 0
  }

  private isScrollingDown (current: number) {
    const result = this.lastCurrentBottom < current

    this.lastCurrentBottom = current
    return result
  }

  private setScrollRouteParams () {
    this.peertubeRouter.addRouteSetting(RouterSetting.REUSE_COMPONENT)
  }
}
