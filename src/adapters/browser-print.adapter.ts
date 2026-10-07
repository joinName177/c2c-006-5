import type{PrintPort}from'../ports/print.port';export class BrowserPrintAdapter implements PrintPort{print(){window.print()}}
