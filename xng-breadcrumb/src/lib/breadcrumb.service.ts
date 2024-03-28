import { Injectable } from '@angular/core';
import {
  ActivatedRoute,
  ActivatedRouteSnapshot,
  GuardsCheckEnd,
  Router,
} from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { filter } from 'rxjs/operators';
import {
  BreadcrumbDefinition,
  Breadcrumb,
  BreadcrumbConfig,
  BreadcrumbObject,
} from './types';

type StoreMatcherKey = 'routeLink' | 'routeRegex' | 'alias';

const PATH_PARAM = {
  PREFIX: ':',
  REGEX_IDENTIFIER: '/:[^/]+',
  REGEX_REPLACER: '/[^/]+',
};
const ALIAS_PREFIX = '@';
const isNonEmpty = (obj: unknown): boolean => {
  return !!obj && Object.keys(obj).length > 0;
};

@Injectable({
  providedIn: 'root',
})
export class BreadcrumbService {
  private baseHref = '/';

  /**
   * dynamicBreadcrumbStore holds information about dynamically updated breadcrumbs.
   * Breadcrumbs can be set from anywhere (component, service) in the app.
   * On every breadcrumb update check this store and use the info if available.
   */
  private dynamicBreadcrumbStore: BreadcrumbDefinition[] = [];

  /**
   * breadcrumbList for the current route
   * When breadcrumb info is changed dynamically, check if the currentBreadcrumbs is effected
   * If effected, update the change and emit a new stream
   */
  private currentBreadcrumbs: BreadcrumbDefinition[] = [];
  private previousBreadcrumbs: BreadcrumbDefinition[] = [];

  /**
   * Breadcrumbs observable to be subscribed by BreadcrumbComponent
   * Emits on every route change OR dynamic update of breadcrumb
   */
  private breadcrumbs = new BehaviorSubject<BreadcrumbDefinition[]>([]);
  public breadcrumbs$ = this.breadcrumbs.asObservable();

  constructor(private activatedRoute: ActivatedRoute, private router: Router) {
    this.detectRouteChanges();
  }

  /**
   * Whenever route changes build breadcrumb list again
   */
  private detectRouteChanges() {
    // Special case where breadcrumb service & component instantiates after a route is navigated.
    // Ex: put breadcrumbs within *ngIf and this.router.events would be empty
    // This check is also required where  { initialNavigation: 'enabledBlocking' } is applied to routes
    this.setupBreadcrumbs(this.activatedRoute.snapshot);

    this.router.events
      .pipe(
        filter(
          (event): event is GuardsCheckEnd => event instanceof GuardsCheckEnd
        )
      )
      .subscribe((event) => {
        // activatedRoute doesn't carry data when shouldReuseRoute returns false
        // use the event data with GuardsCheckEnd as workaround
        // Check for shouldActivate in case where the authGuard returns false the breadcrumbs shouldn't be changed
        if (event.shouldActivate) {
          this.setupBreadcrumbs(event.state.root);
        }
      });
  }

  private setupBreadcrumbs(activatedRouteSnapshot: ActivatedRouteSnapshot) {
    this.previousBreadcrumbs = this.currentBreadcrumbs;
    // breadcrumb label for base OR root path. Usually, this can be set as 'Home'
    const rootBreadcrumb = this.getRootBreadcrumb();
    this.currentBreadcrumbs = rootBreadcrumb ? [rootBreadcrumb] : [];
    this.prepareBreadcrumbList(activatedRouteSnapshot, this.baseHref);
  }

  private getRootBreadcrumb(): Breadcrumb | void {
    const rootConfig = this.router.config.find((config) => config.path === '');
    const rootBreadcrumb = this.extractObject(rootConfig?.data?.['breadcrumb']);
    const storeItem = this.getFromStore(rootBreadcrumb.alias, '/');

    if (isNonEmpty(rootBreadcrumb) || isNonEmpty(storeItem)) {
      return {
        ...storeItem,
        ...rootBreadcrumb,
        routeLink: this.baseHref,
        ...this.getQueryParamsFromPreviousList('/'),
      };
    }
  }

  private prepareBreadcrumbItem(
    activatedRouteSnapshot: ActivatedRouteSnapshot,
    routeLinkPrefix: string
  ): BreadcrumbDefinition {
    const { path, breadcrumb } = this.parseRouteData(
      activatedRouteSnapshot.routeConfig
    );
    const resolvedSegment = this.resolvePathSegment(
      path,
      activatedRouteSnapshot
    );
    const routeLink = `${routeLinkPrefix}${resolvedSegment}`;
    const storeItem = this.getFromStore(breadcrumb.alias, routeLink);

    const label = this.extractLabel(
      storeItem?.label || breadcrumb?.label,
      resolvedSegment
    );
    let isAutoGeneratedLabel = false;
    let autoGeneratedLabel = '';
    if (!label) {
      isAutoGeneratedLabel = true;
      autoGeneratedLabel = resolvedSegment;
    }

    return {
      ...storeItem,
      ...breadcrumb,
      label: isAutoGeneratedLabel ? autoGeneratedLabel : label,
      routeLink,
      isAutoGeneratedLabel,
      ...this.getQueryParamsFromPreviousList(routeLink),
    };
  }

  private prepareBreadcrumbList(
    activatedRouteSnapshot: ActivatedRouteSnapshot,
    routeLinkPrefix: string
  ): Breadcrumb[] | void {
    if (activatedRouteSnapshot.routeConfig?.path) {
      const breadcrumbItem = this.prepareBreadcrumbItem(
        activatedRouteSnapshot,
        routeLinkPrefix
      );
      this.currentBreadcrumbs.push(breadcrumbItem);

      if (activatedRouteSnapshot.firstChild) {
        return this.prepareBreadcrumbList(
          activatedRouteSnapshot.firstChild,
          breadcrumbItem.routeLink + '/'
        );
      }
    } else if (activatedRouteSnapshot.firstChild) {
      return this.prepareBreadcrumbList(
        activatedRouteSnapshot.firstChild,
        routeLinkPrefix
      );
    }
    const lastCrumb =
      this.currentBreadcrumbs[this.currentBreadcrumbs.length - 1];
    this.setQueryParamsForActiveBreadcrumb(lastCrumb, activatedRouteSnapshot);

    // remove breadcrumb items that needs to be hidden
    const breadcrumbsToShow = this.currentBreadcrumbs.filter(
      (item) => !item.skip
    );

    this.breadcrumbs.next(breadcrumbsToShow);
  }

  private getFromStore(alias: string, routeLink: string): BreadcrumbDefinition {
    return this.dynamicBreadcrumbStore.find((item) => {
      return (
        (alias && alias === item.alias) ||
        (routeLink && routeLink === item.routeLink) ||
        this.matchRegex(routeLink, item.routeRegex)
      );
    });
  }

  /**
   * use exact match instead of regexp.test
   * for /mentor/[^/]+ we should match '/mentor/12' but not '/mentor/12/abc'
   */
  private matchRegex(routeLink: string, routeRegex: string) {
    const match = routeLink.match(new RegExp(routeRegex));
    return match?.[0] === routeLink;
  }

  /**
   * if the path segment has route params, read the param value from url
   * for each segment of route this gets called
   *
   * for mentor/:id/view - it gets called with mentor, :id, view 3 times
   */
  private resolvePathSegment(
    segment: string,
    activatedRouteSnapshot: ActivatedRouteSnapshot
  ) {
    //quirk -segment can be defined as view/:id in route config in which case you need to make it view/<resolved-param>
    if (segment.includes(PATH_PARAM.PREFIX)) {
      Object.entries(activatedRouteSnapshot.params).forEach(([key, value]) => {
        segment = segment.replace(`:${key}`, `${value}`);
      });
    }
    return segment;
  }

  /**
   * queryParams & fragments for previous breadcrumb path are copied over to new list
   */
  private getQueryParamsFromPreviousList(routeLink: string): Breadcrumb {
    const { queryParams, fragment } =
      this.previousBreadcrumbs.find((item) => item.routeLink === routeLink) ||
      {};
    return { queryParams, fragment };
  }

  /**
   * set current activated route query params to the last breadcrumb item
   */
  private setQueryParamsForActiveBreadcrumb(
    lastItem: Breadcrumb,
    activatedRouteSnapshot: ActivatedRouteSnapshot
  ) {
    if (lastItem) {
      const { queryParams, fragment } = activatedRouteSnapshot;
      lastItem.queryParams = queryParams ? { ...queryParams } : undefined;
      lastItem.fragment = fragment;
    }
  }

  /**
   * For a specific route, breadcrumb can be defined either on parent OR it's child(which has empty path)
   * When both are defined, child takes precedence
   *
   * Ex: Below we are setting breadcrumb on both parent and child.
   * So, child takes precedence and "Defined On Child" is displayed for the route 'home'
   * { path: 'home', loadChildren: () => import('./home/home.module').then((m) => m.HomeModule) , data: {breadcrumb: "Defined On Module"}}
   *                                                AND
   * children: [
   *   { path: '', component: ShowUserComponent, data: {breadcrumb: "Defined On Child" }
   * ]
   */
  private parseRouteData(routeConfig) {
    const { path, data } = routeConfig;
    const breadcrumb = this.mergeWithBaseChildData(
      routeConfig,
      data?.breadcrumb
    );

    return { path, breadcrumb };
  }

  /**
   * get empty children of a module or Component. Empty child is the one with path: ''
   * When parent and it's children (that has empty route path) define data merge them both with child taking precedence
   */
  private mergeWithBaseChildData(
    routeConfig: any,
    config: BreadcrumbConfig
  ): BreadcrumbObject {
    if (!routeConfig) {
      return this.extractObject(config);
    }

    let baseChild;
    if (routeConfig.loadChildren) {
      // To handle a module with empty child route
      baseChild = routeConfig._loadedRoutes.find((route) => route.path === '');
    } else if (routeConfig.children) {
      // To handle a component with empty child route
      baseChild = routeConfig.children.find((route) => route.path === '');
    }

    const childConfig = baseChild?.data?.breadcrumb;
    return childConfig
      ? this.mergeWithBaseChildData(baseChild, {
          ...this.extractObject(config),
          ...this.extractObject(childConfig),
        })
      : this.extractObject(config);
  }

  /**
   * Update breadcrumb dynamically
   *
   * key can be a path | alias
   *
   * 1) Using complete route path. route can be passed the same way you define angular routes
   * - path can be passed as 'exact path(routeLink)' or 'path with params(routeRegex)'
   * - update label Ex: set('/mentor', 'Mentor'), set('/mentor/:id', 'Mentor Details')
   * - change visibility Ex: set('/mentor/:id/edit', { skip: true })
   * ------------------------------------------ OR ------------------------------------------
   * 2) Using route alias (prefixed with '@'). alias should be unique for a route
   * - update label Ex: set('@mentor', 'Enabler')
   * - change visibility Ex: set('@mentorEdit', { skip: true })
   *
   *
   * value can be string | BreadcrumbObject | BreadcrumbFunction
   */
  set(key: string, breadcrumb: string | BreadcrumbObject) {
    const breadcrumbObject = this.extractObject(breadcrumb);
    let updateArgs: [StoreMatcherKey, BreadcrumbDefinition];

    if (key.startsWith(ALIAS_PREFIX)) {
      updateArgs = ['alias', { ...breadcrumbObject, alias: key.slice(1) }];
    } else if (key.includes(PATH_PARAM.PREFIX)) {
      updateArgs = [
        'routeRegex',
        { ...breadcrumbObject, routeRegex: this.buildRegex(key) },
      ];
    } else {
      updateArgs = [
        'routeLink',
        { ...breadcrumbObject, routeLink: this.ensureLeadingSlash(key) },
      ];
    }

    // For this route if previously a breadcrumb is not defined that sets isAutoGeneratedLabel: true
    // change it to false since this is user supplied value
    updateArgs[1].isAutoGeneratedLabel = false;

    this.updateStore(...updateArgs);
    this.updateCurrentBreadcrumbs(...updateArgs);
  }

  /**
   * Update the store to reuse for dynamic declarations
   * If the store already has this route definition update it, else add
   */
  private updateStore(key: string, breadcrumb: BreadcrumbDefinition) {
    const storeItemIndex = this.dynamicBreadcrumbStore.findIndex((item) => {
      return breadcrumb[key] === item[key];
    });
    if (storeItemIndex > -1) {
      this.dynamicBreadcrumbStore[storeItemIndex] = {
        ...this.dynamicBreadcrumbStore[storeItemIndex],
        ...breadcrumb,
      };
    } else {
      this.dynamicBreadcrumbStore.push({ ...breadcrumb });
    }
  }

  /**
   * If breadcrumb is present in current breadcrumbs update it and emit new stream
   */
  private updateCurrentBreadcrumbs(
    key: string,
    breadcrumb: BreadcrumbDefinition
  ) {
    const itemIndex = this.currentBreadcrumbs.findIndex((item) => {
      return key === 'routeRegex'
        ? this.matchRegex(item.routeLink, breadcrumb[key])
        : breadcrumb[key] === item[key];
    });
    if (itemIndex > -1) {
      this.currentBreadcrumbs[itemIndex] = {
        ...this.currentBreadcrumbs[itemIndex],
        ...breadcrumb,
      };
      const breadcrumbsToShow = this.currentBreadcrumbs.filter(
        (item) => !item.skip
      );
      this.breadcrumbs.next([...breadcrumbsToShow]);
    }
  }

  /**
   * For a route with path param, we create regex dynamically from angular route syntax
   * '/mentor/:id' becomes '/mentor/[^/]',
   * breadcrumbService.set('/mentor/:id', 'Uday') should update 'Uday' as label for '/mentor/2' OR 'mentor/ada'
   */
  private buildRegex(path: string) {
    return this.ensureLeadingSlash(path).replace(
      new RegExp(PATH_PARAM.REGEX_IDENTIFIER, 'g'),
      PATH_PARAM.REGEX_REPLACER
    );
  }

  private ensureLeadingSlash(path: string) {
    return path.startsWith('/') ? path : `/${path}`;
  }

  /**
   * In App's RouteConfig, breadcrumb can be defined as a string OR a function OR an object
   *
   * string: simple static breadcrumb label for a path
   * function: callback that gets invoked with resolved path param
   * object: additional data defined along with breadcrumb label that gets passed to *xngBreadcrumbItem directive
   */
  private extractLabel(config: BreadcrumbConfig, resolvedParam?: string) {
    const label = typeof config === 'object' ? config.label : config;
    if (typeof label === 'function') {
      return label(resolvedParam);
    }
    return label;
  }

  private extractObject(config: BreadcrumbConfig): BreadcrumbObject {
    // don't include {label} if config is undefined. This is important since we merge the configs
    if (
      config &&
      (typeof config === 'string' || typeof config === 'function')
    ) {
      return { label: config };
    }
    return (config as BreadcrumbObject) || {};
  }
}
