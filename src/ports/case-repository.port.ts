import type{SavedCase}from'../core/models';export interface CaseRepository{list():SavedCase[];save(value:SavedCase):void;delete(id:string):void}
