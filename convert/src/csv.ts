import debug from 'debug';
import * as xlsx from 'xlsx';
import oerror from '@overleaf/o-error';
import { getJsDateFromExcel } from 'excel-date-to-js';
import dayjs from 'dayjs';
import ModusResult, { assert as assertModusResult } from '@oada/types/modus/v1/modus-result.js';

const error = debug('@modusjs/convert#csv:error');
const warn = debug('@modusjs/convert#csv:error');
const info = debug('@modusjs/convert#csv:info');
const trace = debug('@modusjs/convert#csv:trace');

export const supportedFormats = [ 'tomkat', 'generic' ];
export type SupportedFormats = 'tomkat' | 'generic';

//--------------------------------------------------------------------------------------
// parse: wrapper function for particular parsing functions found down below.
//
// Ppssible input parameters for xlsx/csv parsing:
// Either give an already-parsed workbook, an entire CSV as a string, or an arraybuffer, or a base64 string
// Default CSV/XLSX format is tomkat

export function parse(
  { wb, str, arrbuf, base64, format }:
  { 
    wb?: xlsx.WorkBook, 
    str?: string, 
    arrbuf?: ArrayBuffer,
    base64?: string, // base64 string
    format?: 'tomkat' | 'generic', // add others here as more become known
  }
): ModusResult[] {

  // Make sure we have an actual workbook to work with:
  if (!wb) {
    try {
      if (str) wb = xlsx.read(str, { type: 'string' });
      if (arrbuf) wb = xlsx.read(arrbuf, { type: 'array' });
      if (base64) wb = xlsx.read(base64, { type: 'base64' });
    } catch(e: any) {
      throw oerror.tag(e, 'Failed to parse input data with xlsx/csv reader');
    }
  }
  if (!wb) {
    throw new Error('No readable input data found.');
  }

  if (!format) format = 'tomkat';

  switch (format) {
    case 'tomkat': return parseTomKat({ wb });
    default: 
      throw new Error(`format type ${format} not currently supported`);
  }
}


//-------------------------------------------------------------------------------------------
// Parse the specific spreadsheet with data from TomKat ranch provided at the 
// 2022 Fixing the Soil Health Tech Stack Hackathon.
function parseTomKat({ wb }: { wb: xlsx.WorkBook }): ModusResult[] {

  // Grab the point meta data out of any master sheet:
  // Any sheet whose name contains "point meta" regardless of spacing, case, or punctuation will be considered
  // point metadata.  i.e. 'Point Meta-Data'  would match as well as 'pointmetadata'
  const pointmeta: { [pointid: string]: any } = {}; // just build this as we go to keep code simpler
  // Split the sheet names into the metadata sheets and the data sheets
  const metadatasheets = wb.SheetNames.filter(isPointMetadataSheetname);
  trace('metadatasheets:', metadatasheets);
  if (metadatasheets) {
    for (const sheetname of metadatasheets) {
      // If you don't put { raw: false } for sheet_to_json, it will parse dates as ints instead of the formatted strings
      const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetname]!, { raw: false }).map(keysToUpperNoSpacesDashesOrUnderscores);
      for (const r of rows ) {
        const id = r['POINTID'] || r['FMISSAMPLEID'];
        if (!id) continue;
        pointmeta[id] = r;
      }
    }
  }

  // Start walking through all the sheets to grab the main data:
  const datasheets = wb.SheetNames.filter(sn => !isPointMetadataSheetname(sn));
  trace('datasheets:', datasheets);
  const ret: ModusResult[] = [];

  for (const sheetname of datasheets) {
    const sheet = wb.Sheets[sheetname]!;
    const allrows = xlsx.utils.sheet_to_json(sheet);

    // Grab the unit overrides and get rid of comment/units columns
    const unit_overrides = extractUnitOverrides(allrows);
    const rows = allrows.filter(isDataRow); 
    trace('Have', rows.length, 'rows from sheetname: ', sheetname);

    // Get a list of all the header names for future reference as needed.  Since objects that have no
    // value in a column might not have that column, we have to look through all the rows and accumulate
    // the unique set of names.
    const colnames_map: { [name: string]: true } = {};
    for (const r of rows) {
      for (const key of Object.keys(r as object)) {
        colnames_map[key] = true;
      }
    }
    const colnames = Object.keys(colnames_map);


    // Determine a "date" column for this dataset
    let datecol = colnames.sort().find(name => name.toUpperCase().match(/DATE/));
    //trace('datecol = ', datecol, ', colnames uppercase = ', colnames.map(c => c.toUpperCase()));
    if (!datecol) {
      error('No date column in sheet', sheetname);
      throw new Error(`Could not find a column containing 'date' in the name to use as the date in sheet ${sheetname}.  A date is required.`);
    }

    // Loop through all the rows and group them by that date.  This group will become a single ModusResult file.
    type DateGroupedRows = { [date: string]: any[] };
    const grouped_rows = rows.reduce((groups: DateGroupedRows, r: any) => {
      let date = r[datecol!]?.toString();
      if (+date < 100000 && +date > 100) { // this is an excel date (# days since 1/1/1900), parse it out
        date = dayjs(getJsDateFromExcel(date)).format('YYYY-MM-DD');
      }
      if (!date) {
        warn('WARNING: row does not have the column we chose for the date (', datecol, '), the row is: ', r);
        return groups;
      }
      if (!groups[date]) groups[date] = [];
      groups[date]!.push(r);
      return groups;
    }, ({} as DateGroupedRows));

    // Now we can loop through all the groups and actually make the darn Modus file:
    let groupcount = 1;
    for (const [date, g_rows] of Object.entries(grouped_rows)) {
      // Start to build the modus output, this is one "Event"
      const output: ModusResult | any = {
        Events: [{
          LabMetaData: {
            Reports: [
              { 
                ReportID: "1",
                FileDescription: `${sheetname}_${groupcount++}`,
              }
            ],
          },
          EventMetaData: {
            EventDate: date, // TODO: process this into the actual date format we are allowed to have in schema.
            EventType: { Soil: true },
          },
          EventSamples: {
            Soil: {
              DepthRefs: [],
              SoilSamples: [],
            },
          },
        }],
      };

      const event = output.Events![0]!;
      const depthrefs = event.EventSamples!.Soil!.DepthRefs!;
      const samples = event.EventSamples!.Soil!.SoilSamples!;

      for (const [index, row] of g_rows.entries()) {
        // Grab the "depth" for this sample:
        const depth = parseDepth(row, unit_overrides, sheetname); // SAM: need to write this to figure out a Depth object
        const DepthID = ''+ensureDepthInDepthRefs(depth, depthrefs); // mutates depthrefs if missing, returns depthid
        const NutrientResults = parseNutrientResults(row, unit_overrides);
        const id = parseSampleID(row);
        const meta = pointmeta[id] || null; // where does the pointmeta go again (Latitude_DD, Longitude_DD, Field, Acreage, etc.)

        const sample: any = {
          SampleMetaData: {
            SampleNumber: ''+index,
            ReportID: "1",
            FMISSampleID: ''+id,
          },
          Depths: [
            { DepthID, NutrientResults }
          ]
        };

        // Parse locations: either in the sample itself or in the meta.  Sample takes precedence over meta.
        let wkt = parseWKTFromPointMetaOrRow(row);
        if (!wkt && meta) {
          //trace('No location info found in row, checking for any in meta');
          wkt = parseWKTFromPointMetaOrRow(meta);
        }
        if (!wkt) {
          //trace('No location info found for row either in the row or in the meta');
        }
        if (wkt) {
          sample.SampleMetaData.Geometry = { wkt };
        }
        samples.push(sample);

      } // end rows for this group
      try {
        assertModusResult(output);
      } catch(e: any) {
        error('assertModusResult failed for sheetname', sheetname, ', group date', date);
        throw oerror.tag(e, `Could not construct a valid ModusResult from sheet ${sheetname}, group date ${date}`);
      }
      ret.push(output);

    } // end looping over all groups
  } // end looping over all the sheets
  
  return ret;
} // end parseTomKat function




//----------------------------------------------
// Helpers
//----------------------------------------------


// Return a new object where all keys are the upper-case equivalents of keys from input object.
function keysToUpperNoSpacesDashesOrUnderscores(obj: any) {
  const ret: any = {};
  for (const [key, val] of Object.entries(obj)) {
    const newkey = key.toUpperCase().replace(/([ _]|-)*/g,'')
    ret[newkey] = typeof val === 'object' ? keysToUpperNoSpacesDashesOrUnderscores(val) : val;
  }
  return ret;
}

function isPointMetadataSheetname(name: string) {
  return name.replace(/([ _,]|-)*/g,'').toUpperCase().match('POINTMETA');
}

type UnitsOverrides = { [colname: string]: string };
function extractUnitOverrides(rows: any[]) {
  const overrides: UnitsOverrides = {};
  const unitrows = rows.filter(isUnitRow);
  // There really should only be one units row
  for (const r of unitrows) {
    for (const [key, val] of Object.entries(r as object)) {
      if (!val) continue; // type-inferred 'nothing' should just not be here
      // keep all the key/value pairs EXCEPT the one that indicated this was a UNITS row
      if (typeof val === 'string' && val.trim() === 'UNITS') continue;
      overrides[key] = val;
    }
  }
  return overrides;
}

// A row is a "data row" if it is not a COMMENT row or a UNIT row
function isDataRow(row: any): boolean {
  const first = !isCommentRow(row);
  const second = !isUnitRow(row);
  const third = !isEmptyRow(row);
  return first && second && third;
}
function isEmptyRow(row: any): boolean {
  if (typeof row !== 'object') return true;
  for (const val of Object.values(row)) {
    if (val) return false; // found anything in the object that is not empty
  }
  return true;
}
function isCommentRow(row: any): boolean {
  return !!Object.values(row).find(val => typeof val === 'string' && val.trim() === 'COMMENT');
}
function isUnitRow(row: any): boolean {
  return !!Object.values(row).find(val => typeof val === 'string' && val.trim() === 'UNITS');
}
type Depth = {
  DepthID?: number, // only the DepthRef has this, don't have it just from the row
  Name: string,
  StartingDepth: number,
  EndingDepth: number,
  ColumnDepth: number,
  DepthUnit: "cm" | "in",
};

function depthsEqual(ref: Depth, depth: Depth) {
  if (ref["DepthUnit"] !== depth["DepthUnit"]) return false;
  if (ref["StartingDepth"] !== depth["StartingDepth"]) return false;
  if (ref["ColumnDepth"] !== depth["ColumnDepth"]) return false;
  if (ref["Name"] !== depth["Name"]) return false;
  if (ref["EndingDepth"] !== depth["EndingDepth"]) return false;
  return true;
}

function ensureDepthInDepthRefs(depth: Depth, depthrefs: Depth[]): number {
  let match = depthrefs.find(ref => depthsEqual(ref, depth));
  if (!match) {
    let DepthID = depthrefs.length+1;
    depthrefs.push({
      ...depth,
      DepthID
    });
    return DepthID
  }
  return match.DepthID!;
}

type NutrientResult = {
  Element: string,
  Value: number,
  ValueUnit: string,
};
function parseSampleID(row: any): string {
  const copy = keysToUpperNoSpacesDashesOrUnderscores(row);
  return copy['POINTID'] || copy['FMISSAMPLEID'] || '';
}

// Make a WKT from point meta's Latitude_DD and Longitude_DD.  Do a "tolerant" parse so anything
// with latitude or longitude (can insensitive) or "lat" and "lon" or "long" would still get a WKT
function parseWKTFromPointMetaOrRow(meta_or_row: any): string {
  let copy = keysToUpperNoSpacesDashesOrUnderscores(meta_or_row);

  let longKey = Object.keys(copy).find(key => key.includes("LONGITUDE"))
  let latKey = Object.keys(copy).find(key => key.includes("LATITUDE"))

  if (copy["LONG"]) longKey = "LONG";
  if (copy["LNG"]) longKey = "LNG";
  if (copy["LON"]) longKey = "LON";
  if (copy["LAT"]) latKey = "LAT";

  if (!longKey) {
    //trace('No longitude for point: ', meta_or_row.POINTID || meta_or_row.FMISSAMPLEID);
    return '';
  }
  if (!latKey) {
    //trace('No latitude for point: ', meta_or_row.POINTID || meta_or_row.FMISSAMPLEID);
    return '';
  }

  let long = copy[longKey];
  let lat = copy[latKey];

  return `POINT(${long} ${lat})`;
}

let nutrientColHeaders: Record<string,any> = {
  "1:1 Soil pH": {
    Element: "pH"
  },
  "pH": {
    Element: "pH",
  },
  "OM": {
    Element: "OM",
    ValueUnit: "%"
  },
  "Organic Matter LOI %": {
    Element: "OM (LOI)",
    ValueUnit: "%"
  },
  "Organic Matter": {
     Element: "OM",
     ValueUnit: "%"
  },
  "OM (LOI)": {
     Element: "OM (LOI)",
     ValueUnit: "%"
  },
  "Olsen P ppm P": {
    Element: "P",
    ValueUnit: "ppm"
  },
  "Bray P-1 ppm P": {
    Element: "P",
    ValueUnit: "ppm"
  },
  "Olsen P": {
    Element: "P",
    ValueUnit: "ug/g"
  },
  "P phosphorus": {
    Element: "P",
    ValueUnit: "ppm"
  },
  "P": {
    Element: "P",
    ValueUnit: "ppm"
  },
  "Pb lead": {
    Element: "Pb",
    ValueUnit: "ppm"
  },
  "Pb": {
    Element: "Pb",
    ValueUnit: "ppm"
  },
  "Potassium ppm K": {
    Element: "K",
    ValueUnit: "ppm"
  },
  "K": {
    Element: "K",
    ValueUnit: "ppm"
  },
  "Potassium": {
    Element: "K",
    ValueUnit: "cmol(+)/kg"
  },
  "K potassium": {
    Element: "K",
    ValueUnit: "ppm"
  },
  "Ca": {
    Element: "Ca",
    ValueUnit: "ppm"
  },
  "Calcium ppm Ca": {
    Element: "Ca",
    ValueUnit: "ppm"
  },
  "Calcium": {
    Element: "Ca",
    ValueUnit: "cmol(+)/kg"
  },
  "Ca calcium": {
    Element: "Ca",
    ValueUnit: "ppm"
  },
  "Cd cadmium": {
    Element: "Cd",
    ValueUnit: "ppm"
  },
  "Cd": {
    Element: "Cd",
    ValueUnit: "ppm"
  },
  "Cr chromium": {
    Element: "Cr",
    ValueUnit: "ppm"
  },
  "Cr": {
    Element: "Cr",
    ValueUnit: "ppm"
  },
  "Magnesium ppm Mg": {
    Element: "Mg",
    ValueUnit: "ppm"
  },
  "Mg": {
    Element: "Mg",
    ValueUnit: "ppm"
  },
  "Magnesium": {
    Element: "Mg",
    ValueUnit: "cmol(+)/kg"
  },
  "Mg magnesium": {
    Element: "Mg",
    ValueUnit: "ppm"
  },
  "Mo": {
    Element: "Mo",
    ValueUnit: "ppm"
  },
  "Mo molybdenum": {
    Element: "Mo",
    ValueUnit: "ppm"
  },
  "CEC/Sum of Cations me/100g": {
    Element: "CEC",
    ValueUnit: "Sum of Cations me/100g"
  },
  "CEC": {
    Element: "CEC",
    ValueUnit: "cmol(+)/kg"
  },
  "CEC (Estimated)": {
    Element: "CEC",
    ValueUnit: "cmol(+)/kg"
  },
  "%Ca Sat": {
    Element: "BS-Ca",
    ValueUnit: "%"
  },
  "BS-Ca": {
    Element: "BS-Ca",
    ValueUnit: "%"
  },
  "BS-Mg": {
    Element: "BS-Mg",
    ValueUnit: "%"
  },
  "%Mg Sat": {
    Element: "BS-Mg",
    ValueUnit: "%"
  },
  "BS-K": {
    Element: "BS-K",
    ValueUnit: "%"
  },
  "%K Sat": {
    Element: "BS-K",
    ValueUnit: "%"
  },
  "BS-Na": {
    Element: "BS-Na",
    ValueUnit: "%"
  },
  "%Na Sat": {
    Element: "BS-Na",
    ValueUnit: "%"
  },
  "%H Sat": {
    Element: "BS-H",
    ValueUnit: "%"
  },
  "BS-H": {
    Element: "BS-H",
    ValueUnit: "%"
  },
  "Sulfate-S ppm S": {
    Element: "SO4-S",
    ValueUnit: "ppm"
  },
  "SO4-S": {
    Element: "SO4-S",
    ValueUnit: "ppm"
  },
  "S sulfur": {
    Element: "S",
    ValueUnit: "ppm"
  },
  "S": {
    Element: "S",
    ValueUnit: "ppm"
  },
  "Zinc ppm Zn": {
    Element: "Zn",
    ValueUnit: "ppm",
  },
  "Zn": {
    Element: "Zn",
    ValueUnit: "ppm",
  },
  "Zn zinc": {
    Element: "Zn",
    ValueUnit: "ppm",
  },
  "Manganese ppm Mn": {
    Element: "Mn",
    ValueUnit: "ppm"
  },
  "Mn": {
    Element: "Mn",
    ValueUnit: "ppm"
  },
  "Mn manganese": {
    Element: "Mn",
    ValueUnit: "ppm"
  },
  "Boron ppm B": {
    Element: "B",
    ValueUnit: "ppm"
  },
  "B": {
    Element: "B",
    ValueUnit: "ppm"
  },
  "B boron": {
    Element: "B",
    ValueUnit: "ppm"
  },
  "Iron ppm Fe": {
    Element: "Fe",
    ValueUnit: "ppm"
  },
  "Iron": {
    Element: "Fe",
    ValueUnit: "ppm"
  },
  "Fe Iron": {
    Element: "Fe",
    ValueUnit: "ppm"
  },
  "Fe": {
    Element: "Fe",
    ValueUnit: "ppm"
  },
  "Cu copper": {
    Element: "Cu",
    ValueUnit: "ppm"
  },
  "Cu": {
    Element: "Cu",
    ValueUnit: "ppm"
  },
  "Copper ppm": {
    Element: "Cu",
    ValueUnit: "ppm"
  },
  "Excess Lime": {
    Element: "Lime Rec",
  },
  "Lime Rec": {
    Element: "Lime Rec",
  },
  "WRDF Buffer pH": {
    Element: "B-pH (W)",
  },
  "BpH (W)": {
    Element: "BpH (W)",
  },
  "1:1 S Salts mmho/cm": {
    ValueUnit: "mmho/cm",
    Element: "SS"
  },
  "SS": {
    ValueUnit: "mmho/cm",
    Element: "SS"
  },
  "Nitrate-N ppm N": {
    Element: "NO3-N",
    ValueUnit: "ppm"
  },
  "Nitrate": {
    Element: "NO3-N",
    ValueUnit: "ppm"
  },
  "NO3-N": {
    Element: "NO3-N",
    ValueUnit: "ppm"
  },
  "Ni nickel": {
    Element: "Ni",
    ValueUnit: "ppm"
  },
  "Ni": {
    Element: "Ni",
    ValueUnit: "ppm"
  },
  "Sodium ppm Na": {
    Element: "Na",
    ValueUnit: "ppm"
  },
  "Na sodium": {
    Element: "Na",
    ValueUnit: "ppm"
  },
  "Na": {
    Element: "Na",
    ValueUnit: "ppm"
  },
  "Sodium": {
    Element: "Na",
    ValueUnit: "cmol(+)/kg"
  },
  "Aluminium ppm Al": {
    Element: "Al",
    ValueUnit: "ppm"
  },
  "Al": {
    Element: "Al",
    ValueUnit: "ppm"
  },
  "Al aluminium": {
    Element: "Al",
    ValueUnit: "ppm"
  },
  "Aluminium": {
    Element: "Al",
    ValueUnit: "ppm"
  },
  "As arsenic": {
    Element: "As",
    ValueUnit: "ppm"
  },
  "As": {
    Element: "As",
    ValueUnit: "ppm"
  },
  "Chloride ppm Cl": {
    Element: "Cl",
    ValueUnit: "ppm"
  },
  "Cl": {
    Element: "Cl",
    ValueUnit: "ppm"
  },
  "Total N ppm": {
    Element: "TN",
    ValueUnit: "ppm"
  },
  "TN": {
    Element: "TN",
    ValueUnit: "ppm"
  },
  "Total Nitrogen^": {
    Element: "TN",
    ValueUnit: "%"
  },
  "Total P ppm": {
    Element: "TP",
    ValueUnit: "ppm"
  },
  "% Sand": {
    Element: "Sand",
    ValueUnit: "%"
  },
  "Sand": {
    Element: "Sand",
    ValueUnit: "%"
  },
  "% Silt": {
    Element: "Silt",
    ValueUnit: "%"
  },
  "Silt": {
    Element: "Silt",
    ValueUnit: "%",
  },
  "% Clay": {
    Element: "Clay",
    ValueUnit: "%"
  },
  "Clay": {
    Element: "Clay",
    ValueUnit: "%"
  },
  "Texture": {
    Element: "Texture",
  },
  "Texture*": {
    Element: "Texture",
  },
  "Bulk Density": {
    Element: "Bulk Density",
    ValueUnit: "g/cm3"
  },
  "Total Org Carbon": {
    Element: "TOC",
    ValueUnit: "%"
  },
  "TOC": {
    Element: "TOC",
    ValueUnit: "%"
  },
  "TN (W)": {
    Element: "TN (W)",
    ValueUnit: "ppm"
  },
  "Water Extractable Total N": {
    Element: "TN (W)",
    ValueUnit: "ppm"
  },
  "TC (W)": {
    Element: "TC (W)",
    ValueUnit: "ppm"
  },
  "Water Extractable Total C": {
    Element: "TC (W)",
    ValueUnit: "ppm"
  },
  "Moisture (Grav)": {
    Element: "Moisture (Grav)",
    ValueUnit: "%"
  },
  "TC": {
    Element: "TC",
    ValueUnit: "ppm"
  },
  /* Didn't see these in the official modus element list
  "LBC 1": {
    Element: "Ca",
    ValueUnit: "ppm"
  },
  "LBC 1": {
    Element: "Ca",
    ValueUnit: "ppm"
  },
  */
}
  /* Didn't see these in the official modus element list
       Element: "Total Microbial Biomass": ,
  "Total Bacteria Biomass": [],
  "Actinomycetes Biomass": [],
  "Gram (-) Biomass": [],
  "Rhizobia Biomass": [],
  "Gram (+) Biomass": [],
  "Total Fungi Biomass": [],
  "Arbuscular Mycorrhizal Biomass": [],
  "Saprophyte Biomass": [],
  "Protozoa Biomass": [],
  "Fungi:Bacteria": [],
  "Gram(+):Gram(-)": [],
  "Sat:Unsat": [],
  "Mono:Poly": []
  */

function parseNutrientResults(row: any, units?: Record<string,string>): NutrientResult[] {
  return Object.keys(row)
    .map(key => key.trim())
    .filter(key => key in nutrientColHeaders)
    .filter(key => !isNaN(row[key]))
    .map(key => key.replace(/\n/g, ' '))
    .map(key => key.replace(/ +/g, ' ').trim())
    .map(key => {
      let unitMatches = key.match(/\[([^\]]+)\]/g)
      let unitStr = '';
      if (unitMatches && unitMatches.length > 0) {
        unitStr = unitMatches[unitMatches.length-1] || '';
        unitStr.replace('[', '').replace(']', '')
      }
      return {
        Element: nutrientColHeaders[key].Element,
        // prioritize user-specified units (from "UNITS" row indicator) over
        // matcher-based units, else "none".
        ValueUnit: unitStr || units![key] || nutrientColHeaders[key].ValueUnit || "none",
        Value: +(row[key]),
      };
    })
}

// sheetname is just for debugging
function parseDepth(row: any, units?: any, sheetname?: string): Depth {
  let obj : any = {
    DepthUnit: "cm" //default to cm
  }

  // Get columns with the word depth
  const copy = keysToUpperNoSpacesDashesOrUnderscores(row);
  const unitsCopy = keysToUpperNoSpacesDashesOrUnderscores(units);
  let depthKey = Object.keys(copy).find(key => key.match(/DEPTH/))
  if (depthKey) {
    let value = copy[depthKey].toString();
    if (unitsCopy[depthKey]) obj.DepthUnit = unitsCopy[depthKey];

    if (value.match(' to ')) {
      obj.StartingDepth = +(value.split(" to ")[0]);
      obj.EndingDepth = +(value.split(" to ")[1]);
      obj.Name = value;
    } else if (value.match(' - ')) {
      obj.StartingDepth = +(value.split(" - ")[0]);
      obj.EndingDepth = +(value.split(" - ")[1]);
      obj.Name = value;
    } else {
      obj.StartingDepth = +(value);
      obj.Name = value;
    }
  }

  if (row["B Depth"]) obj.StartingDepth = +(row["B Depth"]);
  if (row["B Depth"]) obj.Name = ''+row["B Depth"];
  if (units["B Depth"]) obj.DepthUnit = units["B Depth"]; // Assume same for both top and bottom
  if (row["E Depth"]) obj.EndingDepth = +(row["E Depth"]);


  //Insufficient data found
  if (typeof obj.StartingDepth === 'undefined') {
    warn('No depth data was found in sheetname', sheetname, '. Falling back to default depth object.')
    trace('Row without depth was: ', row);
    return {
      StartingDepth: 0,
      EndingDepth: 8,
      DepthUnit: 'in',
      Name: "Unknown Depth",
      ColumnDepth: 8,
    }
  }

  //Handle single depth value
  obj.EndingDepth = obj.EndingDepth || obj.StartingDepth;

  //Now compute column depth
  obj.ColumnDepth = Math.abs(obj.EndingDepth - obj.StartingDepth);

  return obj;
}

export function toCsv(input: ModusResult | ModusResult[]) {

  let data = [];

  if (Array.isArray(input)) {
    data = input.map((mr: ModusResult) => toCsvObject(mr)).flat(1);
  } else {
    data = toCsvObject(input);
  }
  let sheet = xlsx.utils.json_to_sheet(data);

  return {
    wb: {
      Sheets: {"Sheet1": sheet},
      SheetNames: ["Sheet1"]
    } as xlsx.WorkBook,
    str: xlsx.utils.sheet_to_csv(sheet)
  }
}

function toCsvObject(input: ModusResult) {
  return input.Events!.map(event => {
    let eventMeta = {
      EventDate: event.EventMetaData!.EventDate,
      EventType: "Soil" // Hard-coded for now. This is all soil data at the moment
    };

    let allReports = toReportsObj(event.LabMetaData!.Reports);

    let allDepthRefs = toDepthRefsObj(event.EventSamples!.Soil!.DepthRefs)

    return event.EventSamples!.Soil!.SoilSamples!.map(sample => {
      let sampleMeta = toSampleMetaObj(sample.SampleMetaData, allReports);

      return sample.Depths!.map(depth => {
        let nutrients = toNutrientResultsObj(depth)

        return {
          ...eventMeta,
          ...sampleMeta,
          ...allDepthRefs[depth.DepthID!],
          ...nutrients,
        }
      })
    })
  }).flat(3)
}

function toSampleMetaObj(sampleMeta: any, allReports: any) {
  let ll = sampleMeta.Geometry.wkt.replace("POINT(", "").replace(")", "").trim().split(' ');
  return {
    SampleNumber: sampleMeta.SampleNumber,
    ...allReports[sampleMeta.ReportID],
    Latitude: +(ll[0]),
    Longitude: +(ll[1]),
    FMISSampleID: sampleMeta.FMISSampleID
  }
}

function toDepthRefsObj(depthRefs: any) : any  {
  return Object.fromEntries(
    depthRefs.map(
      (dr: Depth) => [dr.DepthID, {
        DepthID: ''+dr.DepthID,
        [`StartingDepth [${dr.DepthUnit}]`]: dr.StartingDepth,
        [`EndingDepth [${dr.DepthUnit}]`]: dr.EndingDepth,
        [`ColumnDepth [${dr.DepthUnit}]`]: dr.ColumnDepth,
      }]
    )
  )
}

function toReportsObj(reports: any) : any  {
  return Object.fromEntries(
    reports.map((r: any) => [r.ReportID, {
      FileDescription: r.FileDescription,
      ReportID: r.ReportID
    }])
  )
}

function toNutrientResultsObj(sampleDepth: any) {
  return Object.fromEntries(
    sampleDepth.NutrientResults.map(
      (nr: NutrientResult) => [`${nr.Element} [${nr.ValueUnit}]`, nr.Value]
    )
  )
}

type ModusCsvRow = {
  ReportID: string,
}

type ModusCsv = ModusCsvRow[];
