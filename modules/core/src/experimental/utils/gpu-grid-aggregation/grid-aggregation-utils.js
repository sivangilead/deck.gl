import assert from 'assert';
import {Matrix4} from 'math.gl';
import {fp64 as fp64Utils} from 'luma.gl';
import {COORDINATE_SYSTEM} from '../../../lib/constants';
const {fp64LowPart} = fp64Utils;

const R_EARTH = 6378000;

// Takes data and aggregation params and returns aggregated data.
export function pointToDensityGridData({
  data,
  getPosition,
  cellSizeMeters,
  gpuGridAggregator,
  gpuAggregation,
  fp64 = false,
  alignToCellBoundary = false,
  coordinateSystem = COORDINATE_SYSTEM.LNGLAT
}) {
  const gridData = _parseGridData(data, getPosition);
  let cellSize = [cellSizeMeters, cellSizeMeters];
  assert(
    coordinateSystem === COORDINATE_SYSTEM.LNGLAT || coordinateSystem === COORDINATE_SYSTEM.IDENTITY
  );
  if (coordinateSystem === COORDINATE_SYSTEM.LNGLAT) {
    // TODO: also for COORDINATE_SYSTEM.LNGLAT_EXPERIMENTAL ?
    const gridOffset = _getGridOffset(gridData, cellSizeMeters);
    cellSize = [gridOffset.xOffset, gridOffset.yOffset];
  }

  const opts = _getGPUAggregationParams({gridData, cellSize, align: alignToCellBoundary});

  const aggregatedData = gpuGridAggregator.run({
    positions: gridData.positions,
    positions64xyLow: gridData.positions64xyLow,
    weights: gridData.weights,
    cellSize,
    width: opts.width,
    height: opts.height,
    gridTransformMatrix: opts.gridTransformMatrix,
    useGPU: gpuAggregation,
    fp64
  });

  return {
    countsBuffer: aggregatedData.countsBuffer,
    maxCountBuffer: aggregatedData.maxCountBuffer,
    gridSize: opts.gridSize,
    gridOrigin: opts.gridOrigin,
    cellSize
  };
}

// Parse input data to build positions, wights and bounding box.
function _parseGridData(data, getPosition, getWeight = null) {
  assert(data && getPosition);
  const positions = [];
  const positions64xyLow = [];
  const weights = [];

  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;
  let y;
  let x;
  for (let p = 0; p < data.length; p++) {
    const position = getPosition(data[p]);
    x = position[0];
    y = position[1];
    positions.push(x, y);
    positions64xyLow.push(fp64LowPart(x), fp64LowPart(y));

    const weight = getWeight ? getWeight(data[p]) : 1.0;
    weights.push(weight);

    if (Number.isFinite(y) && Number.isFinite(x)) {
      yMin = y < yMin ? y : yMin;
      yMax = y > yMax ? y : yMax;

      xMin = x < xMin ? x : xMin;
      xMax = x > xMax ? x : xMax;
    }
  }

  return {
    positions,
    positions64xyLow,
    weights,
    yMin,
    yMax,
    xMin,
    xMax
  };
}

/**
 * Based on geometric center of sample points, calculate cellSize in lng/lat (degree) space
 * @param {object} gridData - contains bounding box of data
 * @param {number} cellSize - grid cell size in meters
 * @returns {yOffset, xOffset} - cellSize size lng/lat (degree) space.
 */

function _getGridOffset(gridData, cellSize) {
  const {yMin, yMax} = gridData;
  const latMin = yMin;
  const latMax = yMax;
  const centerLat = (latMin + latMax) / 2;

  return _calculateGridLatLonOffset(cellSize, centerLat);
}

/**
 * calculate grid layer cell size in lat lon based on world unit size
 * and current latitude
 * @param {number} cellSize
 * @param {number} latitude
 * @returns {object} - lat delta and lon delta
 */
function _calculateGridLatLonOffset(cellSize, latitude) {
  const yOffset = _calculateLatOffset(cellSize);
  const xOffset = _calculateLonOffset(latitude, cellSize);
  return {yOffset, xOffset};
}

/**
 * with a given x-km change, calculate the increment of latitude
 * based on stackoverflow http://stackoverflow.com/questions/7477003
 * @param {number} dy - change in km
 * @return {number} - increment in latitude
 */
function _calculateLatOffset(dy) {
  return (dy / R_EARTH) * (180 / Math.PI);
}

/**
 * with a given x-km change, and current latitude
 * calculate the increment of longitude
 * based on stackoverflow http://stackoverflow.com/questions/7477003
 * @param {number} lat - latitude of current location (based on city)
 * @param {number} dx - change in km
 * @return {number} - increment in longitude
 */
function _calculateLonOffset(lat, dx) {
  return ((dx / R_EARTH) * (180 / Math.PI)) / Math.cos((lat * Math.PI) / 180);
}

// Aligns `inValue` to given `cellSize`
export function _alignToCell(inValue, cellSize) {
  const sign = inValue < 0 ? -1 : 1;

  let value = sign < 0 ? Math.abs(inValue) + cellSize : Math.abs(inValue);

  value = Math.floor(value / cellSize) * cellSize;

  return value * sign;
}

// Calculate grid parameters
function _getGPUAggregationParams({gridData, cellSize, align = false}) {
  const {yMin, yMax, xMin, xMax} = gridData;

  let originX = xMin;
  let originY = yMin;

  if (align) {
    // NOTE: this alignment will match grid cell boundaries with existing CPU implementation
    // this gurantees identical aggregation results between current and new layer.
    // We align the origin to cellSize in positive space lng:[0 360], lat:[0 180]
    // After alignment we move it back to original range
    // Origin = [minX, minY]
    // Origin = Origin + [180, 90] // moving to +ve space
    // Origin = Align(Origin, cellSize) //Align to cell boundary
    // Origin = Origin - [180, 90]
    originY = _alignToCell(yMin + 90, cellSize[1]) - 90;
    originX = _alignToCell(xMin + 180, cellSize[0]) - 180;
  }

  // Setup transformation matrix so that every point is in +ve range
  const gridTransformMatrix = new Matrix4().translate([-1 * originX, -1 * originY, 0]);

  // const cellSize = [gridOffset.xOffset, gridOffset.yOffset];
  const gridOrigin = [originX, originY];
  const width = xMax - xMin + cellSize[0];
  const height = yMax - yMin + cellSize[1];

  const gridSize = [Math.ceil(width / cellSize[0]), Math.ceil(height / cellSize[1])];

  return {
    gridOrigin,
    gridSize,
    width,
    height,
    gridTransformMatrix
  };
}
